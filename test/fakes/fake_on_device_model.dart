import 'dart:async';

import 'package:dry_run/core/ai/on_device_model.dart';

/// A scriptable [OnDeviceModel]. Records the prompts it was asked to answer.
class FakeOnDeviceModel implements OnDeviceModel {
  FakeOnDeviceModel({this.currentStatus = OnDeviceStatus.available});

  OnDeviceStatus currentStatus;

  /// What `generate` answers next; an [OnDeviceException] is thrown, anything else returned.
  final List<Object> replies = <Object>[];

  /// Used when [replies] is empty.
  String defaultReply = 'What do you think happens on the first pass?';

  final List<String> prompts = <String>[];
  int downloads = 0;
  final StreamController<OnDeviceDownloadEvent> _events = StreamController<OnDeviceDownloadEvent>.broadcast();

  void emit(OnDeviceDownloadEvent event) => _events.add(event);

  @override
  Future<OnDeviceStatus> status() async => currentStatus;

  @override
  Future<void> download() async {
    downloads++;
  }

  @override
  Stream<OnDeviceDownloadEvent> downloadEvents() => _events.stream;

  @override
  Future<String> generate(String prompt, {int maxOutputTokens = 256, double temperature = 0.4}) async {
    prompts.add(prompt);
    final Object reply = replies.isEmpty ? defaultReply : replies.removeAt(0);
    if (reply is Exception) throw reply;
    return reply as String;
  }
}
