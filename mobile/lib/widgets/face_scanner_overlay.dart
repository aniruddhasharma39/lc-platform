import 'package:flutter/material.dart';

class FaceScannerOverlay extends StatelessWidget {
  final double ovalWidthRatio;
  final double ovalHeightRatio;
  final Color borderColor;
  final double borderWidth;
  final String statusText;
  final bool isFaceDetected;

  const FaceScannerOverlay({
    super.key,
    this.ovalWidthRatio = 0.72,
    this.ovalHeightRatio = 0.48,
    this.borderColor = const Color(0xFF00E5FF), // Cyan glow
    this.borderWidth = 3.5,
    this.statusText = 'Center your face inside the oval',
    this.isFaceDetected = false,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final height = constraints.maxHeight;

        final ovalRect = Rect.fromCenter(
          center: Offset(width / 2, height * 0.44),
          width: width * ovalWidthRatio,
          height: height * ovalHeightRatio,
        );

        return Stack(
          children: [
            // Dark vignette overlay with transparent cutout
            CustomPaint(
              size: Size(width, height),
              painter: _HolePainter(ovalRect: ovalRect),
            ),

            // Oval Border & Corner Brackets
            CustomPaint(
              size: Size(width, height),
              painter: _OvalBorderPainter(
                ovalRect: ovalRect,
                borderColor: isFaceDetected ? const Color(0xFF00E676) : borderColor,
                borderWidth: borderWidth,
              ),
            ),

            // Instruction Pill at top of oval
            Positioned(
              top: ovalRect.top - 50,
              left: 20,
              right: 20,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.75),
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(
                      color: isFaceDetected
                          ? const Color(0xFF00E676)
                          : const Color(0xFF00E5FF).withValues(alpha: 0.6),
                      width: 1.2,
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        isFaceDetected ? Icons.check_circle : Icons.face,
                        color: isFaceDetected ? const Color(0xFF00E676) : const Color(0xFF00E5FF),
                        size: 18,
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: Text(
                          statusText,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.2,
                          ),
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _HolePainter extends CustomPainter {
  final Rect ovalRect;

  _HolePainter({required this.ovalRect});

  @override
  void paint(Canvas canvas, Size size) {
    final backgroundPath = Path()..addRect(Rect.fromLTWH(0, 0, size.width, size.height));
    final holePath = Path()..addOval(ovalRect);

    final overlayPath = Path.combine(PathOperation.difference, backgroundPath, holePath);

    final paint = Paint()
      ..color = Colors.black.withValues(alpha: 0.72)
      ..style = PaintingStyle.fill;

    canvas.drawPath(overlayPath, paint);
  }

  @override
  bool shouldRepaint(covariant _HolePainter oldDelegate) => oldDelegate.ovalRect != ovalRect;
}

class _OvalBorderPainter extends CustomPainter {
  final Rect ovalRect;
  final Color borderColor;
  final double borderWidth;

  _OvalBorderPainter({
    required this.ovalRect,
    required this.borderColor,
    required this.borderWidth,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = borderWidth;

    // Draw the continuous smooth oval
    canvas.drawOval(ovalRect, paint);

    // Draw 4 corner alignment markers for cinematic railway safety UI
    final markerPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = borderWidth * 1.4;

    const markerLength = 22.0;

    // Top
    canvas.drawLine(
      Offset(ovalRect.center.dx - markerLength, ovalRect.top),
      Offset(ovalRect.center.dx + markerLength, ovalRect.top),
      markerPaint,
    );
    // Bottom
    canvas.drawLine(
      Offset(ovalRect.center.dx - markerLength, ovalRect.bottom),
      Offset(ovalRect.center.dx + markerLength, ovalRect.bottom),
      markerPaint,
    );
    // Left
    canvas.drawLine(
      Offset(ovalRect.left, ovalRect.center.dy - markerLength),
      Offset(ovalRect.left, ovalRect.center.dy + markerLength),
      markerPaint,
    );
    // Right
    canvas.drawLine(
      Offset(ovalRect.right, ovalRect.center.dy - markerLength),
      Offset(ovalRect.right, ovalRect.center.dy + markerLength),
      markerPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _OvalBorderPainter oldDelegate) =>
      oldDelegate.ovalRect != ovalRect ||
      oldDelegate.borderColor != borderColor ||
      oldDelegate.borderWidth != borderWidth;
}
