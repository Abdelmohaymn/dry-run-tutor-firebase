import 'package:dio/dio.dart';

/// Rejects any request whose host is not the configured relay, **before it
/// reaches the socket** (FR-004, Principle VI).
///
/// This is the client half of the reason the relay exists at all: no dio
/// request may reach a model provider, even by accident — a typo'd base URL,
/// a copy-pasted debug request, a future contributor who does not know the
/// rule. (Since feature 010 the model calls themselves go through the
/// Firebase SDK in `core/ai/`, not through dio; dio stays relay-only.) The check happens in
/// `onRequest`, ahead of dio's transport, so a disallowed host throws
/// instead of dialling. `test/security/host_allowlist_test.dart` is what
/// keeps this true.
class HostAllowlistInterceptor extends Interceptor {
  HostAllowlistInterceptor({required this.allowedHost});

  /// The one host this dio instance may ever reach — the relay's host.
  final String allowedHost;

  @override
  void onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) {
    if (options.uri.host != allowedHost) {
      handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.unknown,
          error: DisallowedHostException(options.uri.host, allowedHost),
          message: 'Host "${options.uri.host}" is not the configured relay '
              '("$allowedHost"). Refusing to dial it.',
        ),
      );
      return;
    }
    handler.next(options);
  }
}

/// Thrown (wrapped in a [DioException]) when a request targets any host
/// other than the configured relay. The app speaks to exactly one host —
/// this exception is what makes that a mechanism rather than a promise.
class DisallowedHostException implements Exception {
  DisallowedHostException(this.requestedHost, this.allowedHost);

  final String requestedHost;
  final String allowedHost;

  @override
  String toString() =>
      'DisallowedHostException: "$requestedHost" is not the allowed relay host "$allowedHost"';
}
