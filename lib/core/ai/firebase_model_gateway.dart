import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_ai/firebase_ai.dart';
import 'package:firebase_core/firebase_core.dart';

import '../network/dto/step_dto.dart';
import 'model_gateway.dart';
import 'schema_converter.dart';

/// Makes the relay's model calls through Firebase AI Logic (cloud Gemini).
///
/// FR-006: nothing here logs, stores or forwards a call or its reply — the
/// only things that leave this class are the [ModelAnswer] returned to the step
/// loop and the request to Firebase AI Logic itself. Do not add logging.
class FirebaseModelGateway implements ModelGateway {
  /// [ai] is injectable for tests of the surrounding code; production uses the
  /// Developer API with limited-use App Check tokens (replay-protected).
  FirebaseModelGateway([this._ai]);

  FirebaseAI? _ai;

  FirebaseAI get _client => _ai ??= FirebaseAI.googleAI(useLimitedUseAppCheckTokens: true);

  @override
  Future<ModelAnswer> run(ModelCallDto call) async {
    try {
      final bool asJson = call.output.isJson;
      final GenerativeModel model = _client.generativeModel(
        model: call.model,
        systemInstruction: Content.system(call.system),
        generationConfig: GenerationConfig(
          maxOutputTokens: call.maxOutputTokens,
          temperature: call.temperature,
          responseMimeType: asJson ? 'application/json' : null,
          responseSchema: asJson && call.output.schema != null ? toFirebaseSchema(call.output.schema!) : null,
          thinkingConfig: call.thinkingBudget == null ? null : ThinkingConfig.withThinkingBudget(call.thinkingBudget),
        ),
      );
      final List<Content> history = <Content>[
        for (final StepMessageDto m in call.messages)
          m.role == 'model' ? Content.model(<Part>[TextPart(m.text)]) : Content.text(m.text),
      ];
      final GenerateContentResponse response = await model
          .generateContent(history)
          .timeout(Duration(milliseconds: call.timeoutMs));

      final String? text = response.text;
      if (text == null || text.trim().isEmpty) return const ErrorAnswer(ModelErrorKind.blocked);
      if (!asJson) return TextAnswer(text);
      return JsonAnswer(jsonDecode(text));
    } on FormatException {
      return const ErrorAnswer(ModelErrorKind.badOutput);
    } catch (e) {
      return ErrorAnswer(classifyModelError(e));
    }
  }
}

/// Maps whatever a Firebase AI call threw onto the relay's error vocabulary.
/// Looks at types and message keywords only; never copies the message anywhere.
ModelErrorKind classifyModelError(Object e) {
  if (e is TimeoutException) return ModelErrorKind.timeout;
  if (e is QuotaExceeded) return ModelErrorKind.rateLimited;
  if (e is FirebaseException && e.plugin == 'firebase_app_check') return ModelErrorKind.appCheck;
  if (e is SocketException || e is HttpException) return ModelErrorKind.unavailable;
  final String msg = (e is FirebaseAIException ? e.message : e.toString()).toLowerCase();
  if (msg.contains('app check') || msg.contains('appcheck') || msg.contains('app-check')) {
    return ModelErrorKind.appCheck;
  }
  if (e is FirebaseAIException) {
    if (msg.contains('blocked')) return ModelErrorKind.blocked;
    if (msg.contains('quota') || msg.contains('resource_exhausted') || msg.contains('429')) {
      return ModelErrorKind.rateLimited;
    }
    if (e is ServerException || msg.contains('unavailable') || msg.contains('overloaded') || msg.contains('503')) {
      return ModelErrorKind.unavailable;
    }
  }
  if (msg.contains('socketexception') || msg.contains('clientexception') || msg.contains('failed host lookup')) {
    return ModelErrorKind.unavailable;
  }
  return ModelErrorKind.other;
}
