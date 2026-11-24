import 'package:dry_run/core/network/dto/step_dto.dart';
import 'package:dry_run/features/chat/data/step_loop.dart';
import 'package:mocktail/mocktail.dart';

import 'fake_model_gateway.dart';
import 'mock_relay_client.dart';

/// A real [StepLoop] over a scripted gateway — the relay mock decides what the
/// relay says, the gateway what the model answers.
StepLoop fakeStepLoop([FakeModelGateway? gateway]) => StepLoop(gateway ?? FakeModelGateway());

/// mocktail needs one fallback for the `Map` arguments of the step calls.
void registerStepFallbacks() => registerFallbackValue(<String, Object?>{});

/// The relay's `done` body of a `/v2/turn` step.
StepResponseDto doneTurn(String reply, Map<String, Object?> meta) =>
    StepResponseDto.done(<String, dynamic>{'status': 'done', 'reply': reply, 'meta': meta});

/// The relay's `done` body of a `/v2/judge` step.
StepResponseDto doneJudge(Map<String, Object?> assessment) =>
    StepResponseDto.done(<String, dynamic>{'status': 'done', 'assessment': assessment});

/// The relay's `done` body of a `/v2/repair` step.
StepResponseDto doneRepair(String repaired, {required bool changed}) =>
    StepResponseDto.done(<String, dynamic>{'status': 'done', 'repaired': repaired, 'changed': changed});

When<Future<StepResponseDto>> whenTurnStep(MockRelayClient relay) => when(
  () => relay.turnStep(
    installId: any(named: 'installId'),
    request: any(named: 'request'),
    answers: any(named: 'answers'),
    turnKey: any(named: 'turnKey'),
  ),
);

When<Future<StepResponseDto>> whenJudgeStep(MockRelayClient relay) => when(
  () => relay.judgeStep(
    installId: any(named: 'installId'),
    request: any(named: 'request'),
    answers: any(named: 'answers'),
  ),
);

When<Future<StepResponseDto>> whenRepairStep(MockRelayClient relay) => when(
  () => relay.repairStep(
    installId: any(named: 'installId'),
    request: any(named: 'request'),
    answers: any(named: 'answers'),
  ),
);
