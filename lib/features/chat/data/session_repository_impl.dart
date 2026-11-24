import 'package:drift/drift.dart' show Value;
import 'package:uuid/uuid.dart';

import '../../../core/db/app_database.dart';
import '../../../core/db/dao/message_dao.dart';
import '../../../core/db/dao/session_dao.dart';
import '../../../core/db/dao/assessment_dao.dart';
import '../../../core/db/dao/outbox_dao.dart';
import '../../../core/db/dao/streak_dao.dart';
import '../../../core/ai/model_gateway.dart' show ModelErrorKind;
import '../../../core/ai/on_device_model.dart';
import '../../../core/ai/on_device_model_service.dart';
import '../../../core/errors/relay_error.dart';
import '../../../core/errors/result.dart';
import '../../../core/models/wire_enums.dart';
import '../../../core/text/example_body.dart';
import '../../../core/network/dto/chat_dto.dart';
import '../../../core/network/dto/step_dto.dart';
import '../../../core/network/dto/turn_dto.dart';
import '../../../core/network/relay_client.dart';
import '../../../core/queue/outbox_repository.dart';
import '../../../core/time/trusted_time_source.dart';
import '../../daily/domain/daily_repository.dart';
import '../../daily/domain/daily_selection.dart';
import '../../onboarding/domain/install_identity.dart';
import '../../onboarding/domain/install_repository.dart';
import '../../problem/domain/problem.dart';
import '../../problem/domain/problem_repository.dart';
import '../domain/draft.dart';
import '../domain/ended_by.dart';
import '../domain/hint_rung.dart';
import '../domain/message.dart';
import '../domain/server_counters.dart';
import '../domain/session.dart';
import '../domain/session_repository.dart';
import '../domain/turn_event.dart';
import 'offline_note.dart';
import 'offline_tutor.dart';
import 'step_loop.dart';
import 'turn_event_mapper.dart';

/// A replayed request never carries more than this many turns (FR-020) —
/// a defensive cap alongside `coveredBySummary`'s own bookkeeping, not a
/// substitute for it.
const int _maxReplayedMessages = 40;

class SessionRepositoryImpl implements SessionRepository {
  SessionRepositoryImpl({
    required RelayClient relayClient,
    required SessionDao sessionDao,
    AssessmentDao? assessmentDao,
    OutboxDao? outboxDao,
    required MessageDao messageDao,
    required StreakDao streakDao,
    required ProblemRepository problemRepository,
    required DailyRepository dailyRepository,
    required InstallRepository installRepository,
    required TrustedTimeSource timeSource,
    required OutboxRepository outboxRepository,
    required StepLoop stepLoop,
    OfflineTutor? offlineTutor,
    OnDeviceModelService? onDeviceService,
    Uuid? uuid,
  })  : _relayClient = relayClient,
        _sessionDao = sessionDao,
        _assessmentDao = assessmentDao,
        _outboxDao = outboxDao,
        _messageDao = messageDao,
        _streakDao = streakDao,
        _problemRepository = problemRepository,
        _dailyRepository = dailyRepository,
        _installRepository = installRepository,
        _timeSource = timeSource,
        _outboxRepository = outboxRepository,
        _stepLoop = stepLoop,
        _offlineTutor = offlineTutor,
        _onDevice = onDeviceService,
        _uuid = uuid ?? const Uuid();

  final RelayClient _relayClient;
  final SessionDao _sessionDao;
  final AssessmentDao? _assessmentDao;
  final OutboxDao? _outboxDao;
  final MessageDao _messageDao;
  final StreakDao _streakDao;
  final ProblemRepository _problemRepository;
  final DailyRepository _dailyRepository;
  final OutboxRepository _outboxRepository;
  final StepLoop _stepLoop;
  final OfflineTutor? _offlineTutor;
  final OnDeviceModelService? _onDevice;
  final InstallRepository _installRepository;
  final TrustedTimeSource _timeSource;
  final Uuid _uuid;

  @override
  Future<Session> openOrResumeToday({String? problemId}) async {
    final String day = await _timeSource.today();
    final SessionRow? existing = await _sessionDao.todaysSession(day, problemId: problemId);
    if (existing != null) {
      final Problem problem = (await _problemRepository.byId(existing.problemId))!;
      return _toDomainSession(existing, problem);
    }

    final Problem problem;
    final bool isRepeat;
    if (problemId == null) {
      final DailySelection selection = await _dailyRepository.forToday();
      problem = selection.problem;
      isRepeat = selection.isRepeat;
    } else {
      problem = await _problemRepository.fetchDaily(day, problemId: problemId);
      isRepeat = (await _sessionDao.completedProblemIds()).contains(problem.id);
    }
    // FR-015: no learner key on this entry, so every session is the same path.
    const SessionPath path = SessionPath.trial;
    final DateTime startedAt = (await _timeSource.now()).utc;
    final String id = _uuid.v4();

    await _sessionDao.insertSession(
      SessionsCompanion.insert(
        id: id,
        problemId: problem.id,
        day: day,
        path: path,
        status: SessionStatus.chatting,
        isRepeat: Value(isRepeat),
        startedAt: startedAt,
      ),
    );

    return Session(
      id: id,
      problem: problem,
      day: day,
      path: path,
      status: SessionStatus.chatting,
      counters: ServerCounters.initial,
      isRepeat: isRepeat,
      disputed: false,
      solutionRequestCount: 0,
    );
  }

  @override
  Future<Session?> openOrResumePractice() async {
    final String day = await _timeSource.today();
    final SessionRow? existing = await _sessionDao.practiceSession(day);
    if (existing != null) {
      final Problem? cached = await _problemRepository.byId(existing.problemId);
      if (cached != null) {
        return _toDomainSession(existing, cached);
      }
    }

    final Problem? problem = await _problemRepository.practiceProblem();
    if (problem == null) {
      // A manifest with no warm-up in it — an older relay. The walkthrough
      // is an offer, so its absence is a fallback, not an error.
      return null;
    }

    const SessionPath path = SessionPath.trial;
    final DateTime startedAt = (await _timeSource.now()).utc;
    final String id = _uuid.v4();

    await _sessionDao.insertSession(
      SessionsCompanion.insert(
        id: id,
        problemId: problem.id,
        day: day,
        path: path,
        status: SessionStatus.chatting,
        isPractice: const Value(true),
        startedAt: startedAt,
      ),
    );

    return Session(
      id: id,
      problem: problem,
      day: day,
      path: path,
      status: SessionStatus.chatting,
      counters: ServerCounters.initial,
      isRepeat: false,
      disputed: false,
      solutionRequestCount: 0,
    );
  }

  @override
  Stream<TurnEvent> sendTurn(
    Session session,
    String text,
    InputMode mode, {
    int? solutionRequestCount,
    String? retryMessageId,
    bool finishOfferDismissed = false,
  }) async* {
    final String installId = await _resolvedInstallId();
    final String userMessageId = retryMessageId ?? _uuid.v4();

    if (retryMessageId == null) {
      final int userSeq = await _messageDao.nextSeq(session.id);
      final DateTime now = (await _timeSource.now()).utc;
      await _messageDao.insertMessage(
        MessagesCompanion.insert(
          id: userMessageId,
          sessionId: session.id,
          seq: userSeq,
          role: TurnRole.user,
          body: text,
          kind: MessageKind.turn,
          delivery: Delivery.sending,
          inputMode: Value(mode),
          createdAt: now,
        ),
      );
    } else {
      // The words are already in the conversation, in the place the
      // learner said them. A retry moves that row's delivery state; it
      // never appends a second copy underneath the first.
      await _messageDao.markDelivery(retryMessageId, Delivery.sending);
    }

    ChatRequestDto? request;
    try {
      final List<String> replayedIds;
      (request, replayedIds) = await _buildChatRequest(
        session,
        solutionRequestCount: solutionRequestCount,
        finishOfferDismissed: finishOfferDismissed,
      );
      final Map<String, Object?> requestJson = request.toJson();

      // The relay checks the reply; the app only runs the model calls it asks
      // for (contracts/relay-steps.md). Nothing the loop sees is stored.
      final Map<String, Object?> done = await _stepLoop.run(
        (Map<String, Object?> answers) =>
            _relayClient.turnStep(installId: installId, turnKey: userMessageId, request: requestJson, answers: answers),
      );
      final String reply = done['reply'] as String? ?? '';
      final MetaFrameDto meta = _metaOf(done);

      yield TurnEvent.token(reply);
      await _messageDao.markDelivery(userMessageId, Delivery.sent);
      await _persistTurnReply(
        session: session,
        tutorText: reply,
        counters: countersFromMetaDto(meta),
        replayedIds: replayedIds,
        newSummary: meta.summary,
        summaryCovers: meta.summaryCovers,
        solutionRequestCount: solutionRequestCount,
      );
      yield TurnEvent.meta(countersFromMetaDto(meta));
    } catch (e) {
      // Offline, or the cloud model is rate-limited: the on-device tutor answers
      // if it can (data-model.md §A7). It never replaces a reply the relay would
      // have checked — only a turn that could not be checked at all.
      if (_mayAnswerOffline(e) && _onDevice?.current == OnDeviceStatus.available && _offlineTutor != null) {
        final String? offlineText = await _answerOffline(session, userMessageId, text);
        if (offlineText != null) {
          yield TurnEvent.offlineReply(offlineText);
          return;
        }
      }

      await _messageDao.markDelivery(userMessageId, Delivery.failedRetryable);
      final Object error = e is ModelCallFailed ? e.toRelayException() : e;
      // FR-042: a transport failure — the request never reached the relay
      // at all — is what queues here. A relay-catalogue error (a real
      // response, just not a success) is surfaced to the learner instead
      // (`Failure`'s own copy); it is never queued, because retrying it
      // blindly would fail identically.
      if (error is RelayException && error.error is TransportFailure) {
        if (_onDevice?.current == OnDeviceStatus.downloading) {
          // Offline with the tutor still arriving: say so, and do not queue a
          // turn the learner is about to repeat (spec edge case).
          throw const RelayException(RelayError.offlineTutorDownloading());
        }
        if (request != null) {
          await _outboxRepository.enqueue(
            sessionId: session.id,
            kind: OutboxKind.chatTurn,
            payload: <String, Object?>{'user_message_id': userMessageId, 'request': request.toJson()},
            solutionRequestCountAtEnqueue: session.solutionRequestCount,
          );
        }
      }
      if (error is RelayException) throw error;
      rethrow;
    }
  }

  /// Whether [e] is a failure the on-device tutor may answer in place of the
  /// cloud: the request never reached the relay, or the required tutor call was
  /// rate-limited or the model unavailable. Never App Check — that is not a
  /// capacity problem, and an unattested build must not quietly run a different
  /// tutor (data-model.md §A7).
  bool _mayAnswerOffline(Object e) {
    if (e is RelayException) return e.error is TransportFailure;
    if (e is ModelCallFailed) {
      return e.purpose == 'tutor' && (e.kind == ModelErrorKind.rateLimited || e.kind == ModelErrorKind.unavailable);
    }
    return false;
  }

  /// One offline exchange: the learner's row and the tutor's reply are both
  /// stored as `offline`, the learner's marked sent (it was answered), nothing
  /// queued, no counters touched. Returns the reply, or `null` when the model
  /// could not answer — the caller then handles the original failure, except a
  /// rationed model, which is its own message.
  Future<String?> _answerOffline(Session session, String userMessageId, String text) async {
    final List<Message> before = <Message>[
      for (final MessageRow row in await _messageDao.forSession(session.id))
        if (row.id != userMessageId) _toDomainMessage(row),
    ];
    final MessageRow? current = await _messageDao.byId(userMessageId);
    final List<Message> recent = current == null
        ? before
        : before.where((Message m) => m.seq < current.seq).toList(growable: false);
    final String reply;
    try {
      reply = await _offlineTutor!.reply(session.problem, recent, text);
    } on OnDeviceException catch (e) {
      switch (e.code) {
        case OnDeviceErrorCode.notReady:
          return null;
        case OnDeviceErrorCode.busy:
          await _messageDao.markDelivery(userMessageId, Delivery.failedRetryable);
          throw const RelayException(RelayError.offlineTutorBusy());
        case OnDeviceErrorCode.background:
        case OnDeviceErrorCode.failed:
          await _messageDao.markDelivery(userMessageId, Delivery.failedRetryable);
          throw const RelayException(RelayError.unclearRetry());
      }
    }

    await _messageDao.markOrigin(userMessageId, MessageOrigin.offline);
    await _messageDao.markDelivery(userMessageId, Delivery.sent);
    final DateTime now = (await _timeSource.now()).utc;
    await _messageDao.insertMessage(
      MessagesCompanion.insert(
        id: _uuid.v4(),
        sessionId: session.id,
        seq: await _messageDao.nextSeq(session.id),
        role: TurnRole.tutor,
        body: reply,
        kind: MessageKind.turn,
        delivery: Delivery.sent,
        origin: Value(MessageOrigin.offline),
        createdAt: now,
      ),
    );
    return reply;
  }

  @override
  Future<Result<HintRung>> pullHint(Session session) async {
    try {
      final String installId = await _resolvedInstallId();
      // The conversation so far, not `const []`: the wire schema requires
      // `messages` to carry the turns a reply would be grounded in, and
      // sending an empty array made every hint pull a 400 the learner read
      // as "something failed on our side" (found on device). The hint
      // branch reaches no provider and spends no turn either way (FR-027)
      // — this is the request *shape* the relay validates, not extra
      // context the ladder consumes.
      final (ChatRequestDto request, _) = await _buildChatRequest(session, hintRequested: true);
      final Map<String, Object?> requestJson = request.toJson();

      final Map<String, Object?> done = await _runStepLoop(
        (Map<String, Object?> answers) =>
            _relayClient.turnStep(installId: installId, request: requestJson, answers: answers),
      );
      final String? hintText = done['reply'] as String?;
      if (hintText == null) {
        return const Err(RelayError.unclearRetry());
      }
      final ServerCounters counters = countersFromMetaDto(_metaOf(done));

      // The server flattens the authored ladder and returns its own fixed
      // closing line once `hints_revealed` runs past the ladder's length
      // (worker/src/lib/hint-ladder.ts's `LADDER_EXHAUSTED`) — indistinguishable
      // from a real rung by `hints_remaining` alone, since that is already
      // zero on the *last* real rung too. Comparing the 1-based index this
      // pull just produced against the problem's own authored count is
      // what tells the two apart without guessing at the session's prior
      // state (T083's placeholder-zero lesson, applied here).
      final bool exhausted = counters.hintsRevealed > session.problem.hintCount;

      final int seq = await _messageDao.nextSeq(session.id);
      final DateTime now = (await _timeSource.now()).utc;
      await _messageDao.insertMessage(
        MessagesCompanion.insert(
          id: _uuid.v4(),
          sessionId: session.id,
          seq: seq,
          role: TurnRole.tutor,
          body: hintText,
          kind: exhausted ? MessageKind.ladderExhausted : MessageKind.hintRung,
          delivery: Delivery.sent,
          createdAt: now,
        ),
      );
      await _applyCounters(session.id, counters, newSummary: null);

      return Ok(HintRung(index: counters.hintsRevealed, text: hintText, exhausted: exhausted));
    } on RelayException catch (e) {
      return Err(e.error);
    } catch (_) {
      return const Err(RelayError.transport());
    }
  }

  @override
  Future<int?> revealNextExample(Session session) async {
    final List<ProblemExample> examples = session.problem.examples;
    final List<MessageRow> rows = await _messageDao.forSession(session.id);
    final int alreadyShown =
        rows.where((MessageRow r) => r.kind == MessageKind.example).length;
    if (alreadyShown >= examples.length) {
      return null;
    }
    final ProblemExample example = examples[alreadyShown];
    final int seq = await _messageDao.nextSeq(session.id);
    final DateTime now = (await _timeSource.now()).utc;
    await _messageDao.insertMessage(
      MessagesCompanion.insert(
        id: _uuid.v4(),
        sessionId: session.id,
        seq: seq,
        role: TurnRole.tutor,
        body: renderExampleBody(example.input, example.output, example.explanation),
        kind: MessageKind.example,
        delivery: Delivery.sent,
        createdAt: now,
      ),
    );
    return alreadyShown + 1;
  }

  @override
  Future<void> saveDraft(Session session, Draft draft) async {
    final DateTime now = (await _timeSource.now()).utc;
    await _sessionDao.upsertDraft(
      DraftsCompanion.insert(
        sessionId: session.id,
        body: draft.text,
        recognised: Value(draft.recognised),
        repaired: Value(draft.repaired),
        inputMode: draft.inputMode,
        updatedAt: now,
      ),
    );
  }

  @override
  Future<Draft?> loadDraft(Session session) async {
    final DraftRow? row = await _sessionDao.draftFor(session.id);
    if (row == null) {
      return null;
    }
    return Draft(
      text: row.body,
      recognised: row.recognised,
      repaired: row.repaired,
      inputMode: row.inputMode,
    );
  }

  @override
  Future<void> deleteDraft(Session session) => _sessionDao.deleteDraft(session.id);

  @override
  Future<Result<void>> resetForPracticeAgain(Session session) async {
    try {
      if (_assessmentDao == null || _outboxDao == null) {
        return const Err(RelayError.transport());
      }
      final String installId = await _resolvedInstallId();
      await _relayClient.resetSession(installId: installId, problemId: session.problem.id);
      await _sessionDao.transaction(() async {
        await _assessmentDao.deleteForSession(session.id);
        await _outboxDao.deleteForSession(session.id);
        await _sessionDao.deleteDraft(session.id);
        await _messageDao.deleteForSession(session.id);
        await _sessionDao.deleteSession(session.id);
      });
      return const Ok(null);
    } on RelayException catch (e) {
      return Err(e.error);
    } catch (_) {
      return const Err(RelayError.transport());
    }
  }

  @override
  Future<Session> promoteToKeyed(Session session, String providerId) async {
    final SessionRow current = (await _sessionDao.byId(session.id))!;
    await _sessionDao.updateSession(
      current.copyWith(path: SessionPath.keyed, providerId: Value(providerId)),
    );
    return session.copyWith(path: SessionPath.keyed, providerId: providerId);
  }

  @override
  Future<Session> endSession(Session session, EndedBy reason) async {
    final DateTime completedAt = (await _timeSource.now()).utc;
    await _sessionDao.transaction(() async {
      final SessionRow current = (await _sessionDao.byId(session.id))!;
      await _sessionDao.updateSession(
        current.copyWith(
          status: SessionStatus.pendingJudge,
          completedAt: Value(completedAt),
          sessionEnded: Value(reason.wireName),
        ),
      );
      // FR-036, Principle IV: credited here, in the same transaction,
      // before any judge request exists — no verdict and no network
      // state can reach back and undo it.
      await _streakDao.credit(session.day, creditedAt: completedAt);
    });
    return session.copyWith(
      status: SessionStatus.pendingJudge,
      counters: ServerCounters(
        turnIndex: session.counters.turnIndex,
        turnsRemaining: session.counters.turnsRemaining,
        hintsRevealed: session.counters.hintsRevealed,
        hintsRemaining: session.counters.hintsRemaining,
        sessionEnded: reason.wireName,
        leakBlocked: session.counters.leakBlocked,
      ),
    );
  }

  @override
  Stream<Session> watch(String sessionId) async* {
    await for (final SessionRow? row in _sessionDao.watchById(sessionId)) {
      if (row == null) {
        continue;
      }
      final Problem problem = (await _problemRepository.byId(row.problemId))!;
      yield _toDomainSession(row, problem);
    }
  }

  @override
  Stream<List<Message>> watchMessages(String sessionId) {
    return _messageDao.watchForSession(sessionId).map(
          (List<MessageRow> rows) => rows.map(_toDomainMessage).toList(growable: false),
        );
  }

  // --- internals ---------------------------------------------------

  Future<String> _resolvedInstallId() async {
    final Result<InstallIdentity> result = await _installRepository.ensureIdentity();
    return switch (result) {
      Ok<InstallIdentity>(:final value) => value.installId,
      Err<InstallIdentity>(:final error) => throw RelayException(error),
    };
  }


  /// The request, and the ids of the rows it replays, in the same order as
  /// its `messages` — `summary_covers` counts from the front of that list.
  Future<(ChatRequestDto, List<String>)> _buildChatRequest(
    Session session, {
    int? solutionRequestCount,
    bool? hintRequested,
    bool finishOfferDismissed = false,
  }) async {
    // Offline-tutor rows stay in the transcript but are never replayed as history (FR-011a).
    final List<MessageRow> uncovered = (await _messageDao.uncoveredForSession(session.id))
        .where((MessageRow m) => m.origin == MessageOrigin.online)
        .toList(growable: false);
    final List<MessageRow> capped = uncovered.length > _maxReplayedMessages
        ? uncovered.sublist(uncovered.length - _maxReplayedMessages)
        : uncovered;
    // From the row, not `session`: the Cubit's copy only ever takes new
    // counters, so its `summary` stayed null after the relay sent one and
    // the summary was never replayed (found on device 2026-09-25).
    final SessionRow? row = await _sessionDao.byId(session.id);
    final List<String> earlier = await _messageDao.coveredLearnerTurns(session.id);
    final ChatRequestDto request = ChatRequestDto(
      problemId: session.problem.id,
      messages: capped.map((MessageRow m) => TurnDto(role: m.role.name, text: m.body)).toList(),
      summary: row?.summary ?? session.summary,
      earlierLearnerTurns: earlier.isEmpty
          ? null
          : earlier.sublist(earlier.length > _maxReplayedMessages ? earlier.length - _maxReplayedMessages : 0),
      hintRequested: hintRequested,
      solutionRequestCount: solutionRequestCount,
      finishOfferDismissed: finishOfferDismissed ? true : null,
      // What the learner said to the offline tutor since the last online turn (FR-011a).
      offlineNote: hintRequested == true ? null : offlineNote(await _allMessages(session.id)),
    );
    return (request, capped.map((MessageRow m) => m.id).toList());
  }

  Future<List<Message>> _allMessages(String sessionId) async => <Message>[
        for (final MessageRow row in await _messageDao.forSession(sessionId)) _toDomainMessage(row),
      ];

  /// Runs one relay step loop; a model call that had to stop it comes out as
  /// the catalogue error the learner-facing surfaces already render.
  Future<Map<String, Object?>> _runStepLoop(
    Future<StepResponseDto> Function(Map<String, Object?> answers) post,
  ) async {
    try {
      return await _stepLoop.run(post);
    } on ModelCallFailed catch (e) {
      throw e.toRelayException();
    }
  }

  MetaFrameDto _metaOf(Map<String, Object?> done) {
    final Object? meta = done['meta'];
    if (meta is! Map) {
      throw const RelayException(RelayError.unclearRetry());
    }
    return MetaFrameDto.fromJson(Map<String, dynamic>.from(meta));
  }

  /// Inserts the tutor's reply and applies the turn's counters, folding
  /// any newly-covered messages into a fresh `summary` (FR-020).
  Future<void> _persistTurnReply({
    required Session session,
    required String tutorText,
    required ServerCounters counters,
    required List<String> replayedIds,
    String? newSummary,
    int? summaryCovers,
    int? solutionRequestCount,
  }) async {
    final DateTime now = (await _timeSource.now()).utc;
    final int tutorSeq = await _messageDao.nextSeq(session.id);
    await _messageDao.insertMessage(
      MessagesCompanion.insert(
        id: _uuid.v4(),
        sessionId: session.id,
        seq: tutorSeq,
        role: TurnRole.tutor,
        body: tutorText.isEmpty ? ' ' : tutorText,
        kind: counters.leakBlocked ? MessageKind.fallbackRedirect : MessageKind.turn,
        delivery: Delivery.sent,
        createdAt: now,
      ),
    );
    await _applyCounters(
      session.id,
      counters,
      newSummary: newSummary,
      solutionRequestCount: solutionRequestCount,
    );
    // Only the rows the relay says it folded in. With no count (a relay
    // older than `summary_covers`) nothing is marked: the next summary may
    // repeat some of this one, which beats losing the recent turns.
    if (newSummary != null && summaryCovers != null) {
      await _messageDao.markCoveredBySummary(replayedIds.take(summaryCovers).toList());
    }
  }

  Future<void> _applyCounters(
    String sessionId,
    ServerCounters counters, {
    String? newSummary,
    int? solutionRequestCount,
  }) async {
    final SessionRow current = (await _sessionDao.byId(sessionId))!;
    await _sessionDao.updateSession(
      current.copyWith(
        turnIndex: counters.turnIndex,
        turnsRemaining: Value(counters.turnsRemaining),
        hintsRevealed: counters.hintsRevealed,
        hintsRemaining: Value(counters.hintsRemaining),
        sessionEnded: Value(counters.sessionEnded),
        summary: newSummary == null ? const Value.absent() : Value(newSummary),
        // Accepted by the relay, so the count this turn asked for is now
        // the row's own truth (Principle III) — the server never echoes
        // it back, this is the one write. `SessionRow.copyWith` (the data
        // class, not the companion) takes a plain nullable `int` here —
        // `null` means "leave unchanged", not "clear it" — so this is
        // passed straight through rather than `Value`-wrapped.
        solutionRequestCount: solutionRequestCount,
      ),
    );
  }

  Message _toDomainMessage(MessageRow row) => Message(
        id: row.id,
        seq: row.seq,
        role: row.role,
        text: row.body,
        kind: row.kind,
        delivery: row.delivery,
        recognisedDraft: row.recognisedDraft,
        inputMode: row.inputMode,
        origin: row.origin,
      );

  Session _toDomainSession(SessionRow row, Problem problem) => Session(
        id: row.id,
        problem: problem,
        day: row.day,
        path: row.path,
        status: row.status,
        counters: ServerCounters(
          turnIndex: row.turnIndex,
          turnsRemaining: row.turnsRemaining ?? 0,
          hintsRevealed: row.hintsRevealed,
          hintsRemaining: row.hintsRemaining ?? 0,
          sessionEnded: row.sessionEnded,
          leakBlocked: false,
        ),
        summary: row.summary,
        isRepeat: row.isRepeat,
        disputed: row.disputed,
        solutionRequestCount: row.solutionRequestCount,
      );
}
