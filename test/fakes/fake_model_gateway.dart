import 'package:dry_run/core/ai/model_gateway.dart';
import 'package:dry_run/core/network/dto/step_dto.dart';

/// A gateway that answers from a script keyed by call id. Unscripted calls
/// get a plain text answer. Records the ids it was asked to run.
class FakeModelGateway implements ModelGateway {
  FakeModelGateway([Map<String, ModelAnswer>? script]) : script = script ?? <String, ModelAnswer>{};

  final Map<String, ModelAnswer> script;
  final List<String> ran = <String>[];

  @override
  Future<ModelAnswer> run(ModelCallDto call) async {
    ran.add(call.id);
    return script[call.id] ?? TextAnswer('answer-${call.id}');
  }
}

ModelCallDto fakeCall(String id, {String purpose = 'tutor', bool required = true}) => ModelCallDto(
  id: id,
  purpose: purpose,
  model: 'm',
  system: 's',
  messages: const <StepMessageDto>[StepMessageDto(role: 'user', text: 'u')],
  output: const ModelOutputDto(kind: 'text'),
  maxOutputTokens: 100,
  temperature: 0.2,
  timeoutMs: 1000,
  required: required,
);
