import '../network/dto/step_dto.dart';

/// Why a model call produced no usable answer. Wire names are the relay's
/// `error` vocabulary (contracts/relay-steps.md §ModelAnswer).
enum ModelErrorKind {
  rateLimited('rate_limited'),
  unavailable('unavailable'),
  timeout('timeout'),
  blocked('blocked'),
  badOutput('bad_output'),

  /// App Check could not attest. Never sent to the relay — it aborts the loop.
  appCheck('app_check'),
  other('other');

  const ModelErrorKind(this.wire);

  final String wire;
}

/// The app's answer to one [ModelCallDto] (app → relay).
sealed class ModelAnswer {
  const ModelAnswer();

  Map<String, Object?> toJson();
}

final class TextAnswer extends ModelAnswer {
  const TextAnswer(this.text);

  final String text;

  @override
  Map<String, Object?> toJson() => <String, Object?>{'text': text};
}

final class JsonAnswer extends ModelAnswer {
  const JsonAnswer(this.json);

  final Object? json;

  @override
  Map<String, Object?> toJson() => <String, Object?>{'json': json};
}

final class ErrorAnswer extends ModelAnswer {
  const ErrorAnswer(this.kind);

  final ModelErrorKind kind;

  @override
  Map<String, Object?> toJson() => <String, Object?>{'error': kind.wire};
}

/// Makes one model call. The only implementation that touches a network is
/// `FirebaseModelGateway`; tests use a fake. Must never log or persist the
/// call or the reply (FR-006).
abstract interface class ModelGateway {
  Future<ModelAnswer> run(ModelCallDto call);
}
