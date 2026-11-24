// quickstart.md §4. The repository is where FR-006 (fail open) is
// implemented — every failure mode below must return `null`, never throw.
import 'package:dry_run/core/errors/relay_error.dart';
import 'package:dry_run/core/network/relay_client.dart';
import 'package:dry_run/core/models/wire_enums.dart';
import 'package:dry_run/features/chat/domain/server_counters.dart';
import 'package:dry_run/features/chat/domain/session.dart';
import 'package:dry_run/features/problem/domain/problem.dart';
import 'package:dry_run/features/transcript/data/transcript_repair_repository_impl.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import '../fakes/fake_install_repository.dart';
import '../fakes/mock_relay_client.dart';
import '../fakes/step_fakes.dart';

const Problem _problem = Problem(
  schemaVersion: 2,
  id: 'vp-0001',
  title: 'Two Sum',
  ramp: 'easy',
  tags: <String>[],
  source: 'authored',
  statement: 'Given an array of integers...',
  constraints: <String>[],
  estSpeakSeconds: 60,
  collections: <String>[],
  glossaryTerms: <String>[],
  hintCount: 3,
);

Session _session({required SessionPath path}) => Session(
      id: 'session-1',
      problem: _problem,
      day: '2026-01-01',
      path: path,
      status: SessionStatus.chatting,
      counters: ServerCounters.initial,
      isRepeat: false,
      disputed: false,
      solutionRequestCount: 0,
    );

void main() {
  setUpAll(registerStepFallbacks);

  late MockRelayClient relayClient;
  late FakeInstallRepository installRepository;
  late TranscriptRepairRepositoryImpl repository;

  setUp(() {
    relayClient = MockRelayClient();
    installRepository = FakeInstallRepository();
    repository = TranscriptRepairRepositoryImpl(
      relayClient: relayClient,
      installRepository: installRepository,
      stepLoop: fakeStepLoop(),
    );
  });

  test('a 200 with changed: true returns the repaired text', () async {
    whenRepairStep(relayClient).thenAnswer(
      (_) async => doneRepair('I would use a hash map', changed: true),
    );

    final String? result = await repository.repair(
      session: _session(path: SessionPath.keyed),
      transcript: 'I would use a hash mop',
    );

    expect(result, 'I would use a hash map');
  });

  test('a 200 with changed: false returns null', () async {
    whenRepairStep(relayClient).thenAnswer(
      (_) async => doneRepair('unchanged text', changed: false),
    );

    final String? result = await repository.repair(
      session: _session(path: SessionPath.keyed),
      transcript: 'unchanged text',
    );

    expect(result, isNull);
  });

  for (final RelayError error in <RelayError>[
    const RelayError.badRequest(),
    const RelayError.invalidKey(),
    const RelayError.rateLimited(retryAfter: Duration(seconds: 5)),
    const RelayError.unclearRetry(),
    const RelayError.transport(),
  ]) {
    test('a thrown RelayException(${error.runtimeType}) returns null and throws nothing', () async {
      whenRepairStep(relayClient).thenThrow(RelayException(error));

      final String? result = await repository.repair(
        session: _session(path: SessionPath.keyed),
        transcript: 'some transcript',
      );

      expect(result, isNull);
    });
  }

  test('a transport-level exception also returns null', () async {
    whenRepairStep(relayClient).thenThrow(Exception('socket closed'));

    final String? result = await repository.repair(
      session: _session(path: SessionPath.keyed),
      transcript: 'some transcript',
    );

    expect(result, isNull);
  });

  test('the repair request goes through the step loop with the problem id and the transcript', () async {
    whenRepairStep(relayClient).thenAnswer((_) async => doneRepair('some transcript', changed: false));

    final String? result = await repository.repair(
      session: _session(path: SessionPath.trial),
      transcript: 'some transcript',
    );

    expect(result, isNull);
    final Map<String, Object?> request = verify(
      () => relayClient.repairStep(
        installId: any(named: 'installId'),
        request: captureAny(named: 'request'),
        answers: any(named: 'answers'),
      ),
    ).captured.single as Map<String, Object?>;
    expect(request['problem_id'], 'vp-0001');
    expect(request['transcript'], 'some transcript');
  });
}
