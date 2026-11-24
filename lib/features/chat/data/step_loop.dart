import '../../../core/ai/model_gateway.dart';
import '../../../core/errors/relay_error.dart';
import '../../../core/network/dto/step_dto.dart';
import '../../../core/network/relay_client.dart';

/// A model call that could not be answered and must stop the loop: a
/// `required` call failed, or App Check refused to attest.
class ModelCallFailed implements Exception {
  const ModelCallFailed(this.kind, this.purpose);

  final ModelErrorKind kind;
  final String purpose;

  @override
  String toString() => 'ModelCallFailed(${kind.wire}, $purpose)';
}

extension ModelCallFailedRelayError on ModelCallFailed {
  /// The catalogue error a learner-facing surface already knows how to show.
  RelayException toRelayException() => RelayException(switch (kind) {
    ModelErrorKind.rateLimited => const RelayError.rateLimited(retryAfter: Duration(seconds: 30)),
    ModelErrorKind.appCheck => const RelayError.clientUnverified(),
    ModelErrorKind.unavailable ||
    ModelErrorKind.timeout ||
    ModelErrorKind.blocked ||
    ModelErrorKind.badOutput ||
    ModelErrorKind.other => const RelayError.unclearRetry(),
  });
}

/// Drives the relay step protocol (contracts/relay-steps.md): POST, run the
/// model calls the relay asks for, POST again with the answers, until `done`.
///
/// Calls and answers live in locals of [run] only and are dropped when it
/// returns or throws (research.md R12, FR-006).
class StepLoop {
  StepLoop(this._gateway);

  /// Most POSTs one loop may make, restarts included.
  static const int maxPosts = 6;

  final ModelGateway _gateway;

  /// [post] sends one step with the answers gathered so far and returns the
  /// relay's reply. Returns the `done` body.
  ///
  /// Throws [ModelCallFailed] when the loop cannot continue, and
  /// [RelayException] (`unclearRetry`) when it runs out of POSTs or the relay
  /// keeps reporting divergence. Relay errors from [post] pass through.
  Future<Map<String, Object?>> run(Future<StepResponseDto> Function(Map<String, Object?> answers) post) async {
    Map<String, Object?> answers = <String, Object?>{};
    bool restarted = false;

    for (int posts = 0; posts < maxPosts; posts++) {
      final StepResponseDto step;
      try {
        step = await post(answers);
      } on StepDivergedException {
        if (restarted) {
          throw const RelayException(RelayError.unclearRetry());
        }
        restarted = true;
        answers = <String, Object?>{};
        continue;
      }

      final Map<String, dynamic>? done = step.done;
      if (done != null) {
        return Map<String, Object?>.from(done);
      }

      final List<ModelCallDto> calls = step.calls!;
      final List<ModelAnswer> results = await Future.wait(calls.map(_gateway.run));
      for (int i = 0; i < calls.length; i++) {
        final ModelCallDto call = calls[i];
        final ModelAnswer answer = results[i];
        if (answer is ErrorAnswer && (answer.kind == ModelErrorKind.appCheck || call.required)) {
          throw ModelCallFailed(answer.kind, call.purpose);
        }
        answers[call.id] = answer.toJson();
      }
    }
    throw const RelayException(RelayError.unclearRetry());
  }
}
