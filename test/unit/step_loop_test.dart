import 'package:dry_run/core/ai/model_gateway.dart';
import 'package:dry_run/core/errors/relay_error.dart';
import 'package:dry_run/core/network/dto/step_dto.dart';
import 'package:dry_run/core/network/relay_client.dart';
import 'package:dry_run/features/chat/data/step_loop.dart';
import 'package:flutter_test/flutter_test.dart';

import '../fakes/fake_model_gateway.dart';

StepResponseDto _model(List<ModelCallDto> calls) => StepResponseDto.model(calls);
StepResponseDto _done([String reply = 'ok']) => StepResponseDto.done(<String, dynamic>{'status': 'done', 'reply': reply});

void main() {
  test('two stages succeed; answers accumulate across POSTs', () async {
    final FakeModelGateway gw = FakeModelGateway();
    final List<Map<String, Object?>> seen = <Map<String, Object?>>[];
    final List<StepResponseDto> replies = <StepResponseDto>[
      _model(<ModelCallDto>[fakeCall('a'), fakeCall('b', required: false)]),
      _model(<ModelCallDto>[fakeCall('c')]),
      _done('final'),
    ];
    final Map<String, Object?> out = await StepLoop(gw).run((Map<String, Object?> answers) async {
      seen.add(<String, Object?>{...answers});
      return replies[seen.length - 1];
    });
    expect(out['reply'], 'final');
    expect(seen[0], isEmpty);
    expect(seen[1].keys, <String>['a', 'b']);
    expect(seen[2].keys, <String>['a', 'b', 'c']);
    expect(seen[2]['c'], <String, Object?>{'text': 'answer-c'});
  });

  test('a failed required call stops the loop', () async {
    final FakeModelGateway gw = FakeModelGateway(<String, ModelAnswer>{'a': const ErrorAnswer(ModelErrorKind.timeout)});
    await expectLater(
      StepLoop(gw).run((_) async => _model(<ModelCallDto>[fakeCall('a')])),
      throwsA(isA<ModelCallFailed>().having((ModelCallFailed e) => e.kind, 'kind', ModelErrorKind.timeout)),
    );
  });

  test('an App Check failure stops the loop even on an optional call', () async {
    final FakeModelGateway gw = FakeModelGateway(<String, ModelAnswer>{'a': const ErrorAnswer(ModelErrorKind.appCheck)});
    await expectLater(
      StepLoop(gw).run((_) async => _model(<ModelCallDto>[fakeCall('a', required: false)])),
      throwsA(isA<ModelCallFailed>()),
    );
  });

  test('a failed optional call is sent to the relay as an error answer', () async {
    final FakeModelGateway gw = FakeModelGateway(<String, ModelAnswer>{'p': const ErrorAnswer(ModelErrorKind.rateLimited)});
    Map<String, Object?>? second;
    int n = 0;
    await StepLoop(gw).run((Map<String, Object?> answers) async {
      n++;
      if (n == 1) return _model(<ModelCallDto>[fakeCall('t'), fakeCall('p', required: false)]);
      second = answers;
      return _done();
    });
    expect(second!['p'], <String, Object?>{'error': 'rate_limited'});
    expect(second!['t'], <String, Object?>{'text': 'answer-t'});
  });

  test('STEP_DIVERGED restarts once with empty answers, a second one gives up', () async {
    final FakeModelGateway gw = FakeModelGateway();
    final List<int> sizes = <int>[];
    final Map<String, Object?> out = await StepLoop(gw).run((Map<String, Object?> answers) async {
      sizes.add(answers.length);
      if (sizes.length == 1) return _model(<ModelCallDto>[fakeCall('a')]);
      if (sizes.length == 2) throw const StepDivergedException();
      return _done();
    });
    expect(out['reply'], 'ok');
    expect(sizes, <int>[0, 1, 0]);

    await expectLater(
      StepLoop(gw).run((_) async => throw const StepDivergedException()),
      throwsA(isA<RelayException>().having((RelayException e) => e.error, 'error', const RelayError.unclearRetry())),
    );
  });

  test('gives up after 6 POSTs', () async {
    int posts = 0;
    await expectLater(
      StepLoop(FakeModelGateway()).run((_) async {
        posts++;
        return _model(<ModelCallDto>[fakeCall('c$posts')]);
      }),
      throwsA(isA<RelayException>()),
    );
    expect(posts, StepLoop.maxPosts);
  });
}
