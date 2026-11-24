import 'package:dry_run/core/network/relay_client.dart';
import 'package:mocktail/mocktail.dart';

/// A mocktail mock of the whole relay client. Tutor turns, judges and repairs
/// are scripted through `whenTurnStep` / `whenJudgeStep` / `whenRepairStep`
/// (test/fakes/step_fakes.dart).
class MockRelayClient extends Mock implements RelayClient {}
