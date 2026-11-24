import 'package:flutter/foundation.dart';

import '../network/dto/step_dto.dart';
import 'model_gateway.dart';

/// Debug builds only (wired in `setupLocator()` under `kDebugMode`, and its
/// Settings switch is rendered under `kDebugMode`): answers the cloud tutor
/// call as rate-limited when the switch is on, so the offline fallback can be
/// tried without exhausting a real quota (spec US3, quickstart §5 step 4).
class DebugModelGateway implements ModelGateway {
  DebugModelGateway(this._inner);

  /// "Simulate cloud rate limit".
  static final ValueNotifier<bool> simulateRateLimit = ValueNotifier<bool>(false);

  final ModelGateway _inner;

  @override
  Future<ModelAnswer> run(ModelCallDto call) async {
    if (simulateRateLimit.value && call.purpose == 'tutor') {
      return const ErrorAnswer(ModelErrorKind.rateLimited);
    }
    return _inner.run(call);
  }
}
