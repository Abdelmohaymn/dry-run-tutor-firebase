// FR-006, research.md R12: ground truth reaches the app inside a ModelCall's
// `system` (feature 010) and must live in memory only. Run a turn and a judge
// through the real repositories with an in-memory Drift DB, a relay that
// asks for a call whose system carries a marker, and a fake gateway — then
// assert the marker is in no table row and no outbox payload.
import 'package:dry_run/core/config/runtime_config.dart';
import 'package:dry_run/core/db/app_database.dart';
import 'package:dry_run/core/errors/relay_error.dart';
import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/core/network/dto/step_dto.dart';
import 'package:dry_run/core/network/relay_client.dart' show RelayException;
import 'package:dry_run/features/assessment/data/assessment_repository_impl.dart';
import 'package:dry_run/features/chat/data/session_repository_impl.dart';
import 'package:dry_run/features/chat/domain/session.dart';
import 'package:dry_run/features/daily/data/daily_repository_impl.dart';
import 'package:dry_run/features/problem/data/problem_repository_impl.dart';
import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes/fake_config_repository.dart';
import '../fakes/fake_install_repository.dart';
import '../fakes/fake_model_gateway.dart';
import '../fakes/fake_outbox_repository.dart';
import '../fakes/fake_trusted_time_source.dart';
import '../fakes/mock_relay_client.dart';
import '../fakes/step_fakes.dart';

const String _marker = 'GT_MARKER_7f3a';

/// A relay step that asks for one call whose system prompt carries the marker.
StepResponseDto _modelStep(String id, String purpose) => StepResponseDto.model(<ModelCallDto>[
  ModelCallDto(
    id: id,
    purpose: purpose,
    model: 'm',
    system: 'ground truth: $_marker',
    messages: const <StepMessageDto>[StepMessageDto(role: 'user', text: 'the learner said something')],
    output: const ModelOutputDto(kind: 'text'),
    maxOutputTokens: 100,
    temperature: 0.2,
    timeoutMs: 1000,
    required: true,
  ),
]);

/// Every cell of every table, as one string.
Future<String> _dumpDatabase(AppDatabase db) async {
  final StringBuffer out = StringBuffer();
  final rows = await db.customSelect("SELECT name FROM sqlite_master WHERE type = 'table'").get();
  for (final row in rows) {
    final String table = row.read<String>('name');
    for (final r in await db.customSelect('SELECT * FROM "$table"').get()) {
      out.writeln(r.data);
    }
  }
  return out.toString();
}

void main() {
  late AppDatabase db;
  late MockRelayClient relay;
  late FakeOutboxRepository outbox;
  late FakeModelGateway gateway;
  late SessionRepositoryImpl sessions;
  late AssessmentRepositoryImpl assessments;
  late FakeTrustedTimeSource time;

  setUpAll(registerStepFallbacks);

  setUp(() async {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    relay = MockRelayClient();
    outbox = FakeOutboxRepository();
    gateway = FakeModelGateway();
    time = FakeTrustedTimeSource();
    final FakeRemoteConfigRepository config = FakeRemoteConfigRepository()
      ..cachedValue = const RuntimeConfig(
        minSupportedVersion: '1.0.0',
        killedProblemIds: <String>[],
        chat: ChatConfig(turnCap: 12, wrapUpAtTurn: 9, minTurnChars: 8),
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
    sessions = SessionRepositoryImpl(
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
    );
    assessments = AssessmentRepositoryImpl(
      relayClient: relay,
      assessmentDao: db.assessmentDao,
      sessionDao: db.sessionDao,
      messageDao: db.messageDao,
      installRepository: FakeInstallRepository(),
      timeSource: time,
      outboxRepository: outbox,
      stepLoop: fakeStepLoop(gateway),
    );
  });

  tearDown(() => db.close());

  test('a turn whose model call carries ground truth leaves no trace in Drift', () async {
    final Session session = await sessions.openOrResumeToday();
    int posts = 0;
    whenTurnStep(relay).thenAnswer((_) async {
      if (posts++ == 0) return _modelStep('c_0000000000000001', 'tutor');
      return doneTurn('What would you look up?', <String, Object?>{
        'turn_index': 1,
        'turns_remaining': 9,
        'hints_revealed': 0,
        'hints_remaining': 3,
        'session_ended': null,
        'leak_blocked': false,
      });
    });

    await for (final _ in sessions.sendTurn(session, 'I would use a hashmap.', InputMode.text)) {}

    expect(gateway.ran, <String>['c_0000000000000001'], reason: 'the call was really run');
    expect(await _dumpDatabase(db), isNot(contains(_marker)));
    expect(outbox.enqueued.toString(), isNot(contains(_marker)));
  });

  test('a turn that fails after the calls ran queues only the original request', () async {
    final Session session = await sessions.openOrResumeToday();
    int posts = 0;
    whenTurnStep(relay).thenAnswer((_) async {
      if (posts++ == 0) return _modelStep('c_0000000000000002', 'tutor');
      throw const RelayException(RelayError.transport());
    });

    await expectLater(
      sessions.sendTurn(session, 'I would use a hashmap.', InputMode.text).drain<void>(),
      throwsA(isA<RelayException>()),
    );

    expect(outbox.enqueued, hasLength(1), reason: 'a transport failure queues the turn');
    expect(outbox.enqueued.toString(), isNot(contains(_marker)));
    expect(outbox.enqueued.toString(), contains('hashmap'), reason: 'the queued payload is the request');
    expect(await _dumpDatabase(db), isNot(contains(_marker)));
  });

  test('a judge whose model call carries ground truth leaves no trace in Drift', () async {
    final Session session = await sessions.openOrResumeToday();
    await db.messageDao.insertMessage(
      MessagesCompanion.insert(
        id: 'm1',
        sessionId: session.id,
        seq: 0,
        role: TurnRole.user,
        body: 'my answer',
        kind: MessageKind.turn,
        delivery: Delivery.sent,
        createdAt: time.utc,
      ),
    );
    int posts = 0;
    whenJudgeStep(relay).thenAnswer((_) async {
      if (posts++ == 0) return _modelStep('c_0000000000000003', 'judge');
      return doneJudge(<String, Object?>{
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
      });
    });

    await assessments.request(session);

    expect(gateway.ran, <String>['c_0000000000000003']);
    expect(await _dumpDatabase(db), isNot(contains(_marker)));
    expect(outbox.enqueued.toString(), isNot(contains(_marker)));
  });
}
