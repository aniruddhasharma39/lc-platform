import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/main.dart';

void main() {
  testWidgets('App launches smoke test', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const MyApp());
    await tester.pump();
    expect(find.byType(MyApp), findsOneWidget);
  });

  testWidgets('Bottom SafeArea reserves Android navigation bar inset while preserving top inset', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues({});
    final dpr = tester.view.devicePixelRatio;
    tester.view.padding = FakeViewPadding(top: 24.0 * dpr, bottom: 48.0 * dpr);
    tester.view.viewPadding = FakeViewPadding(top: 24.0 * dpr, bottom: 48.0 * dpr);
    addTearDown(() {
      tester.view.resetPadding();
      tester.view.resetViewPadding();
    });

    await tester.pumpWidget(const MyApp());
    await tester.pump();

    final authRect = tester.getRect(find.byType(AuthWrapper));
    final viewHeight = tester.view.physicalSize.height / dpr;
    // Bottom edge stops cleanly above the 48dp Android 3-button bar, while top remains at y=0 for AppBar.
    expect(authRect.top, equals(0.0));
    expect(authRect.bottom, closeTo(viewHeight - 48.0, 0.1));
  });
}
