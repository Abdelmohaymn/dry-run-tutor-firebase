import 'dart:async';

import '../../../core/ai/on_device_model.dart';
import '../../problem/domain/problem.dart';
import '../domain/message.dart';
import 'offline_prompt.dart';

/// Longest reply the offline tutor may show (research.md R11).
const int _maxReplyChars = 600;

/// Words that would be a verdict. The offline tutor has no answer to check
/// against, so any of these in its reply is replaced by the fixed line.
/// English only: other languages are out of scope for this guard (R11).
final RegExp _verdict = RegExp(r'\b(correct|wrong|right answer|solution is)\b', caseSensitive: false);

/// One offline turn: prompt → Gemini Nano → guard. The guard (R11) swaps the
/// reply for [fallbackLine] when it is empty, too long, contains a code fence or
/// sounds like a verdict, so the learner never reads one offline.
class OfflineTutor {
  OfflineTutor({
    required OnDeviceModel model,
    required String Function() fallbackLine,
    Duration timeout = const Duration(seconds: 30),
  }) : _model = model,
       _fallbackLine = fallbackLine,
       _timeout = timeout;

  final OnDeviceModel _model;
  final String Function() _fallbackLine;
  final Duration _timeout;

  /// Throws [OnDeviceException] when the model could not answer, including on
  /// timeout (reported as `failed`).
  Future<String> reply(Problem problem, List<Message> recent, String learnerText) async {
    final String prompt = buildOfflinePrompt(problem, recent, learnerText);
    final String raw;
    try {
      raw = await _model.generate(prompt, maxOutputTokens: 256, temperature: 0.4).timeout(_timeout);
    } on TimeoutException {
      throw const OnDeviceException(OnDeviceErrorCode.failed);
    }
    return _guard(raw);
  }

  String _guard(String raw) {
    final String text = raw.trim();
    if (text.isEmpty || text.length > _maxReplyChars || text.contains('```') || _verdict.hasMatch(text)) {
      return _fallbackLine();
    }
    return text;
  }
}
