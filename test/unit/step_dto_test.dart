import 'package:dry_run/core/ai/model_gateway.dart';
import 'package:dry_run/core/network/dto/step_dto.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses a model step and never prints call content', () {
    final StepResponseDto r = StepResponseDto.fromJson(<String, dynamic>{
      'status': 'model',
      'calls': <Object>[
        <String, Object?>{
          'id': 'c_1',
          'purpose': 'tutor',
          'model': 'gemini-3.8-flash',
          'system': 'SECRET-GROUND-TRUTH',
          'messages': <Object>[
            <String, String>{'role': 'user', 'text': 'hi'},
          ],
          'output': <String, Object?>{'kind': 'text'},
          'max_output_tokens': 400,
          'temperature': 0.4,
          'thinking_budget': null,
          'timeout_ms': 20000,
          'required': true,
        },
      ],
    });
    expect(r.isDone, isFalse);
    final ModelCallDto c = r.calls!.single;
    expect(c.thinkingBudget, isNull);
    expect(c.temperature, 0.4);
    expect(c.toString(), isNot(contains('SECRET')));
  });

  test('parses a done step', () {
    final StepResponseDto r = StepResponseDto.fromJson(<String, dynamic>{'status': 'done', 'reply': 'x'});
    expect(r.isDone, isTrue);
    expect(r.done!['reply'], 'x');
  });

  test('answers serialise to the wire shape', () {
    expect(const TextAnswer('a').toJson(), <String, Object?>{'text': 'a'});
    expect(const JsonAnswer(<String, int>{'k': 1}).toJson(), <String, Object?>{
      'json': <String, int>{'k': 1},
    });
    expect(const ErrorAnswer(ModelErrorKind.badOutput).toJson(), <String, Object?>{'error': 'bad_output'});
  });
}
