// data-model.md §A7 / spec US2–US3: when the cloud tutor cannot answer, the
// on-device tutor does — and nothing about that exchange reaches the relay as
// history, the turn cap, or the judge.
import 'package:dry_run/core/ai/model_gateway.dart';
import 'package:dry_run/core/ai/on_device_model.dart';
import 'package:dry_run/core/ai/on_device_model_service.dart';
import 'package:dry_run/core/config/runtime_config.dart';
import 'package:dry_run/core/db/app_database.dart';
import 'package:dry_run/core/errors/relay_error.dart';
import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/core/network/dto/chat_dto.dart';
import 'package:dry_run/core/errors/result.dart';
import 'package:dry_run/core/network/dto/step_dto.dart';
import 'package:dry_run/core/network/relay_client.dart' show RelayException;
import 'package:dry_run/features/assessment/data/assessment_repository_impl.dart';
import 'package:dry_run/features/chat/data/offline_tutor.dart';
import 'package:dry_run/features/chat/data/session_repository_impl.dart';
import 'package:dry_run/features/chat/domain/ended_by.dart';
import 'package:dry_run/features/chat/domain/session.dart';
import 'package:dry_run/features/chat/domain/turn_event.dart';
import 'package:dry_run/features/daily/data/daily_repository_impl.dart';
import 'package:dry_run/features/problem/data/problem_repository_impl.dart';
import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../fakes/fake_config_repository.dart';
import '../fakes/fake_install_repository.dart';
import '../fakes/fake_model_gateway.dart';
import '../fakes/fake_on_device_model.dart';
import '../fakes/fake_outbox_repository.dart';
import '../fakes/fake_trusted_time_source.dart';
import '../fakes/mock_relay_client.dart';
import '../fakes/step_fakes.dart';

const Map<String, Object?> _meta = <String, Object?>{
  'turn_index': 1,
  'turns_remaining': 9,
  'hints_revealed': 0,
  'hints_remaining': 3,
  'session_ended': null,
  'leak_blocked': false,
};

class _Harness {
  _Harness._(this.db, this.relay, this.outbox, this.onDevice, this.service, this.gateway, this.repository);

  final AppDatabase db;
  final MockRelayClient relay;
  final FakeOutboxRepository outbox;
  final FakeOnDeviceModel onDevice;
  final OnDeviceModelService service;
  final FakeModelGateway gateway;
  final SessionRepositoryImpl repository;

  /// Every request sent to the relay, in order.
  final List<ChatRequestDto> sent = <ChatRequestDto>[];

  static Future<_Harness> create({OnDeviceStatus status = OnDeviceStatus.available}) async {
    final AppDatabase db = AppDatabase.forTesting(NativeDatabase.memory());
    final MockRelayClient relay = MockRelayClient();
    final FakeTrustedTimeSource time = FakeTrustedTimeSource();
    final FakeRemoteConfigRepository config = FakeRemoteConfigRepository()
      ..cachedValue = const RuntimeConfig(
        minSupportedVersion: '1.0.0',
        killedProblemIds: <String>[],
        chat: ChatConfig(turnCap: 12, wrapUpAtTurn: 9, minTurnChars: 5),
        trial: TrialConfig(turnCap: 4),
        keyedProviders: <String>['groq'],
      );
    await db.into(db.cachedProblems).insert(
          CachedProblemsCompanion.insert(
            problemId: 'vp-0001',
            schemaVersion: 2,
            title: 'Two Sum',
            ramp: 'easy',
            tags: const <String>[],
            source: 'authored',
            statement: 'Given an array of integers...',
            constraints: const <String>[],
            estSpeakSeconds: 60,
            collections: const <String>[],
            glossaryTerms: const <String>[],
            hintCount: 3,
            manifestDate: Value(await time.today()),
            fetchedAt: time.utc,
          ),
        );
    final ProblemRepositoryImpl problems = ProblemRepositoryImpl(
      relayClient: relay,
      problemDao: db.problemDao,
      timeSource: time,
      installRepository: FakeInstallRepository(),
    );
    final FakeOnDeviceModel onDevice = FakeOnDeviceModel(currentStatus: status);
    final OnDeviceModelService service = OnDeviceModelService(
      model: onDevice,
      isOnline: () async => false,
      autoDownload: false,
      observeLifecycle: false,
    );
    await service.start();
    final FakeModelGateway gateway = FakeModelGateway();
    final FakeOutboxRepository outbox = FakeOutboxRepository();
    final SessionRepositoryImpl repository = SessionRepositoryImpl(
      relayClient: relay,
      sessionDao: db.sessionDao,
      messageDao: db.messageDao,
      streakDao: db.streakDao,
      problemRepository: problems,
      dailyRepository: DailyRepositoryImpl(
        problemRepository: problems,
        sessionDao: db.sessionDao,
        configRepository: config,
        timeSource: time,
      ),
      installRepository: FakeInstallRepository(),
      outboxRepository: outbox,
      timeSource: time,
      stepLoop: fakeStepLoop(gateway),
      offlineTutor: OfflineTutor(model: onDevice, fallbackLine: () => 'FALLBACK LINE'),
      onDeviceService: service,
    );
    final _Harness h = _Harness._(db, relay, outbox, onDevice, service, gateway, repository);
    when(() => relay.turnStep(
          installId: any(named: 'installId'),
          request: any(named: 'request'),
          answers: any(named: 'answers'),
          turnKey: any(named: 'turnKey'),
        )).thenAnswer((Invocation i) async {
      h.sent.add(ChatRequestDto.fromJson(i.namedArguments[#request] as Map<String, Object?>));
      return h.script.removeAt(0)();
    });
    return h;
  }

  /// What the relay does for each POST, in order.
  final List<Future<StepResponseDto> Function()> script = <Future<StepResponseDto> Function()>[];

  Future<List<TurnEvent>> send(Session session, String text) async {
    final List<TurnEvent> events = <TurnEvent>[];
    await for (final TurnEvent e in repository.sendTurn(session, text, InputMode.text)) {
      events.add(e);
    }
    return events;
  }

  Future<List<MessageRow>> rows(Session session) => db.messageDao.forSession(session.id);
}

Future<StepResponseDto> _transportFailure() => Future<StepResponseDto>.error(const RelayException(RelayError.transport()));

Future<StepResponseDto> _askTutor(String id) async => StepResponseDto.model(<ModelCallDto>[fakeCall(id)]);

void main() {
  setUpAll(registerStepFallbacks);

  group('the relay cannot be reached', () {
    test('and the on-device tutor is available: it answers, labelled offline, outside the counters', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script.add(_transportFailure);
      h.onDevice.replies.add('What would that cost on a long list?');

      final List<TurnEvent> events = await h.send(session, 'I would check every pair.');

      expect(events, <Matcher>[isA<TurnEventOfflineReply>().having((e) => e.text, 'text', 'What would that cost on a long list?')]);
      final List<MessageRow> rows = await h.rows(session);
      expect(rows.map((MessageRow r) => (r.role, r.origin, r.delivery)), <(TurnRole, MessageOrigin, Delivery)>[
        (TurnRole.user, MessageOrigin.offline, Delivery.sent),
        (TurnRole.tutor, MessageOrigin.offline, Delivery.sent),
      ]);
      expect(h.outbox.enqueued, isEmpty, reason: 'an offline turn is answered, not queued');
      final Session after = await h.repository.openOrResumeToday();
      expect(after.counters.turnIndex, 0, reason: 'the relay never saw it');
      expect(h.onDevice.prompts.single, contains('Two Sum'));
    });

    test('the next online turn leaves the offline rows out of the history and quotes them as a note', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script.add(_transportFailure);
      await h.send(session, 'offline idea one');

      h.script.add(() async => doneTurn('Go on.', _meta));
      await h.send(session, 'now back online');

      final ChatRequestDto request = h.sent.last;
      expect(request.messages.map((m) => m.text), <String>['now back online']);
      expect(request.offlineNote, 'offline idea one');
    });

    test('and the on-device tutor is unavailable: today\'s behaviour — a retryable bubble, queued, transport error', () async {
      final _Harness h = await _Harness.create(status: OnDeviceStatus.unavailable);
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script.add(_transportFailure);

      await expectLater(h.send(session, 'I would check every pair.'), throwsA(isA<RelayException>()));

      final List<MessageRow> rows = await h.rows(session);
      expect(rows.single.delivery, Delivery.failedRetryable);
      expect(rows.single.origin, MessageOrigin.online);
      expect(h.outbox.enqueued, hasLength(1));
      expect(h.onDevice.prompts, isEmpty);
    });

    test('and the on-device tutor is still downloading: says so, queues nothing', () async {
      final _Harness h = await _Harness.create(status: OnDeviceStatus.downloading);
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script.add(_transportFailure);

      await expectLater(
        h.send(session, 'I would check every pair.'),
        throwsA(isA<RelayException>().having((e) => e.error, 'error', isA<OfflineTutorDownloading>())),
      );

      expect((await h.rows(session)).single.delivery, Delivery.failedRetryable);
      expect(h.outbox.enqueued, isEmpty);
    });

    test('and the relay dropped after the model calls ran: the reply was never checked, so the offline tutor answers', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script
        ..add(() => _askTutor('c_1'))
        ..add(_transportFailure);

      final List<TurnEvent> events = await h.send(session, 'I would check every pair.');

      expect(events.single, isA<TurnEventOfflineReply>());
      expect(h.gateway.ran, <String>['c_1'], reason: 'the cloud draft was produced, and never shown');
      expect((await h.rows(session)).map((MessageRow r) => r.body), isNot(contains('answer-c_1')));
    });

    test('the offline model being rationed is a retryable bubble with its own copy', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      h.script.add(_transportFailure);
      h.onDevice.replies.add(const OnDeviceException(OnDeviceErrorCode.busy));

      await expectLater(
        h.send(session, 'I would check every pair.'),
        throwsA(isA<RelayException>().having((e) => e.error, 'error', isA<OfflineTutorBusy>())),
      );
      final MessageRow row = (await h.rows(session)).single;
      expect(row.delivery, Delivery.failedRetryable);
      expect(row.origin, MessageOrigin.online);
      expect(h.outbox.enqueued, isEmpty);
    });
  });

  group('the cloud tutor is rate-limited (US3)', () {
    Future<_Harness> limited({OnDeviceStatus status = OnDeviceStatus.available, ModelErrorKind kind = ModelErrorKind.rateLimited}) async {
      final _Harness h = await _Harness.create(status: status);
      h.gateway.script['c_1'] = ErrorAnswer(kind);
      h.script.add(() => _askTutor('c_1'));
      return h;
    }

    test('with the on-device tutor available: it answers, outside the cap and the judge', () async {
      final _Harness h = await limited();
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();

      final List<TurnEvent> events = await h.send(session, 'I would check every pair.');

      expect(events.single, isA<TurnEventOfflineReply>());
      expect((await h.rows(session)).map((MessageRow r) => r.origin).toSet(), <MessageOrigin>{MessageOrigin.offline});
      expect(h.outbox.enqueued, isEmpty);
      expect((await h.repository.openOrResumeToday()).counters.turnIndex, 0);
    });

    test('a model that is merely unavailable falls back the same way', () async {
      final _Harness h = await limited(kind: ModelErrorKind.unavailable);
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();
      expect((await h.send(session, 'I would check every pair.')).single, isA<TurnEventOfflineReply>());
    });

    test('without it: the rate-limit copy, a retryable bubble, nothing queued', () async {
      final _Harness h = await limited(status: OnDeviceStatus.unavailable);
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();

      await expectLater(
        h.send(session, 'I would check every pair.'),
        throwsA(isA<RelayException>().having((e) => e.error, 'error', isA<RateLimited>())),
      );
      expect((await h.rows(session)).single.delivery, Delivery.failedRetryable);
      expect(h.outbox.enqueued, isEmpty);
    });

    test('App Check failing never falls back: an unattested build does not quietly run a different tutor', () async {
      final _Harness h = await limited(kind: ModelErrorKind.appCheck);
      addTearDown(h.db.close);
      final Session session = await h.repository.openOrResumeToday();

      await expectLater(
        h.send(session, 'I would check every pair.'),
        throwsA(isA<RelayException>().having((e) => e.error, 'error', isA<ClientUnverified>())),
      );
      expect(h.onDevice.prompts, isEmpty);
      expect((await h.rows(session)).single.origin, MessageOrigin.online);
    });
  });

  group('ending the session after offline turns (Principles IV and VIII)', () {
    const Map<String, Object?> assessment = <String, Object?>{
      'matched_approach': 'none',
      'matched_verdict': 'none',
      'insights_hit': <String>[],
      'insights_assisted': <String>[],
      'insights_missed': <String>[],
      'wrong_turns_taken': <String>[],
      'complexity': <String, Object?>{
        'user_claimed_time': null,
        'user_claimed_space': null,
        'reference_time': 'O(n)',
        'reference_space': 'O(n)',
        'assessment': 'not_stated',
      },
      'verdict': 'unclear',
      'confidence': 0.5,
      'feedback': 'ok',
      'editorial': 'ok',
    };

    test('the streak is credited, and the judge sees the online turns only, queued while offline', () async {
      final _Harness h = await _Harness.create();
      addTearDown(h.db.close);
      final FakeTrustedTimeSource time = FakeTrustedTimeSource();
      final AssessmentRepositoryImpl assessments = AssessmentRepositoryImpl(
        relayClient: h.relay,
        assessmentDao: h.db.assessmentDao,
        sessionDao: h.db.sessionDao,
        messageDao: h.db.messageDao,
        installRepository: FakeInstallRepository(),
        timeSource: time,
        outboxRepository: h.outbox,
        stepLoop: fakeStepLoop(),
      );
      final Session opened = await h.repository.openOrResumeToday();

      // One online exchange, then two offline ones.
      h.script.add(() async => doneTurn('Online reply.', _meta));
      await h.send(opened, 'online idea');
      h.script
        ..add(_transportFailure)
        ..add(_transportFailure);
      await h.send(opened, 'OFFLINE_ONE_LEARNER_WORDS');
      await h.send(opened, 'OFFLINE_TWO_LEARNER_WORDS');

      final Session ended = await h.repository.endSession(opened, EndedBy.user);
      expect(await h.db.streakDao.isCredited(ended.day), isTrue, reason: 'ending credits the streak, offline or not');

      // Still offline: the judge is queued, and what is queued excludes the offline rows.
      when(() => h.relay.judgeStep(
            installId: any(named: 'installId'),
            request: any(named: 'request'),
            answers: any(named: 'answers'),
          )).thenThrow(const RelayException(RelayError.transport()));
      final Result<Object?> queued = await assessments.request(ended);
      expect(queued, isA<Err<Object?>>());
      expect(h.outbox.enqueued.where((i) => i.kind == OutboxKind.judge), hasLength(1));
      final String payload = h.outbox.enqueued.last.payload.toString();
      expect(payload, contains('online idea'));
      expect(payload, isNot(contains('OFFLINE_ONE_LEARNER_WORDS')));
      expect(payload, isNot(contains('OFFLINE_TWO_LEARNER_WORDS')));

      // Back online: the same judge call carries the online conversation only.
      Map<String, Object?>? seen;
      when(() => h.relay.judgeStep(
            installId: any(named: 'installId'),
            request: any(named: 'request'),
            answers: any(named: 'answers'),
          )).thenAnswer((Invocation i) async {
        seen = i.namedArguments[#request] as Map<String, Object?>;
        return doneJudge(assessment);
      });
      expect(await assessments.request(ended), isA<Ok<Object?>>());
      final String conversation = seen!['conversation'].toString();
      expect(conversation, contains('online idea'));
      expect(conversation, isNot(contains('OFFLINE_')));
    });
  });
}
