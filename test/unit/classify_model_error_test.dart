import 'dart:async';
import 'dart:io';

import 'package:dry_run/core/ai/firebase_model_gateway.dart';
import 'package:dry_run/core/ai/model_gateway.dart';
import 'package:firebase_ai/firebase_ai.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('maps SDK failures onto the relay error vocabulary', () {
    expect(classifyModelError(TimeoutException('x')), ModelErrorKind.timeout);
    expect(classifyModelError(QuotaExceeded('Quota exceeded')), ModelErrorKind.rateLimited);
    expect(classifyModelError(ServerException('Service unavailable')), ModelErrorKind.unavailable);
    expect(classifyModelError(const SocketException('no route')), ModelErrorKind.unavailable);
    expect(classifyModelError(FirebaseAIException('Response was blocked due to safety')), ModelErrorKind.blocked);
    expect(
      classifyModelError(FirebaseException(plugin: 'firebase_app_check', message: 'token')),
      ModelErrorKind.appCheck,
    );
    expect(classifyModelError(ServerException('App Check token is invalid')), ModelErrorKind.appCheck);
    expect(classifyModelError(StateError('boom')), ModelErrorKind.other);
  });
}
