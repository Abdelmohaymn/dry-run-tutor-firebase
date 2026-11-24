import 'dart:async';

import 'package:dry_run/core/ai/on_device_model.dart';
import 'package:dry_run/features/chat/data/offline_tutor.dart';
import 'package:dry_run/features/problem/domain/problem.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes/fake_on_device_model.dart';

const Problem _problem = Problem(
  schemaVersion: 2,
  id: 'vp-0001',
  title: 'Two Sum',
  ramp: 'easy',
  tags: <String>[],
  source: 'authored',
  statement: 'Given an array...',
  constraints: <String>[],
  estSpeakSeconds: 60,
  collections: <String>[],
  glossaryTerms: <String>[],
  hintCount: 3,
);

const String _fallback = 'Keep going — talk me through your approach step by step.';

void main() {
  late FakeOnDeviceModel model;
  late OfflineTutor tutor;

  setUp(() {
    model = FakeOnDeviceModel();
    tutor = OfflineTutor(model: model, fallbackLine: () => _fallback, timeout: const Duration(milliseconds: 200));
  });

  Future<String> ask() => tutor.reply(_problem, const [], 'I would check every pair.');

  test('a normal reply goes through, trimmed', () async {
    model.replies.add('  What would that cost on a long list?  ');
    expect(await ask(), 'What would that cost on a long list?');
    expect(model.prompts.single, contains('Two Sum'));
  });

  for (final (String name, String reply) in <(String, String)>[
    ('empty', '   '),
    ('too long', 'x' * 601),
    ('a code fence', 'Try this:\n```dart\nfor (...) {}\n```'),
    ('"correct"', 'That is correct, well done.'),
    ('"wrong"', 'Hmm, that is WRONG.'),
    ('"right answer"', 'You have the right answer.'),
    ('"solution is"', 'The solution is a hash map.'),
  ]) {
    test('$name → the fixed line', () async {
      model.replies.add(reply);
      expect(await ask(), _fallback);
    });
  }

  test('a reply that merely contains "correctly" or "rightly" is not a verdict', () async {
    model.replies.add('How would you handle two equal numbers correctly?');
    expect(await ask(), 'How would you handle two equal numbers correctly?');
  });

  test('the channel failing is reported as the model\'s own error', () async {
    model.replies.add(const OnDeviceException(OnDeviceErrorCode.busy));
    await expectLater(ask(), throwsA(isA<OnDeviceException>().having((e) => e.code, 'code', OnDeviceErrorCode.busy)));
  });

  test('a model that never answers times out as failed', () async {
    final OfflineTutor slow = OfflineTutor(
      model: _NeverAnswers(),
      fallbackLine: () => _fallback,
      timeout: const Duration(milliseconds: 20),
    );
    await expectLater(
      slow.reply(_problem, const [], 'hi'),
      throwsA(isA<OnDeviceException>().having((e) => e.code, 'code', OnDeviceErrorCode.failed)),
    );
  });
}

class _NeverAnswers extends FakeOnDeviceModel {
  @override
  Future<String> generate(String prompt, {int maxOutputTokens = 256, double temperature = 0.4}) =>
      Completer<String>().future;
}
