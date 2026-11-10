import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

enum FeedbackType {
  success,
  error,
  warning,
  info,
  loading,
}

class AppFeedback {
  /// Displays a floating success acknowledgment with a green accent and check icon.
  static void showSuccess(
    BuildContext context,
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 3),
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    show(
      context,
      message: message,
      title: title,
      type: FeedbackType.success,
      duration: duration,
      actionLabel: actionLabel,
      onAction: onAction,
    );
  }

  /// Displays a floating error acknowledgment with a red accent and alert icon.
  static void showError(
    BuildContext context,
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 4),
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    show(
      context,
      message: message,
      title: title,
      type: FeedbackType.error,
      duration: duration,
      actionLabel: actionLabel,
      onAction: onAction,
    );
  }

  /// Displays a floating warning acknowledgment with an amber accent and warning icon.
  static void showWarning(
    BuildContext context,
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 3),
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    show(
      context,
      message: message,
      title: title,
      type: FeedbackType.warning,
      duration: duration,
      actionLabel: actionLabel,
      onAction: onAction,
    );
  }

  /// Displays a floating info acknowledgment with a primary/blue accent and info icon.
  static void showInfo(
    BuildContext context,
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 3),
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    show(
      context,
      message: message,
      title: title,
      type: FeedbackType.info,
      duration: duration,
      actionLabel: actionLabel,
      onAction: onAction,
    );
  }

  /// Displays a persistent in-progress acknowledgment with an animated spinner.
  static void showLoading(
    BuildContext context,
    String message, {
    String? title,
    Duration duration = const Duration(minutes: 2),
  }) {
    show(
      context,
      message: message,
      title: title,
      type: FeedbackType.loading,
      duration: duration,
    );
  }

  /// Master method for displaying styled contextual floating SnackBars.
  static void show(
    BuildContext context, {
    required String message,
    String? title,
    FeedbackType type = FeedbackType.info,
    Duration duration = const Duration(seconds: 3),
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    if (!context.mounted) return;

    // Trigger subtle tactile haptic feedback
    try {
      switch (type) {
        case FeedbackType.success:
          HapticFeedback.lightImpact();
          break;
        case FeedbackType.error:
          HapticFeedback.mediumImpact();
          break;
        case FeedbackType.warning:
          HapticFeedback.mediumImpact();
          break;
        case FeedbackType.info:
          HapticFeedback.selectionClick();
          break;
        case FeedbackType.loading:
          break;
      }
    } catch (_) {}

    // Resolve semantic theme colors and icons
    Color backgroundColor;
    Color iconColor;
    IconData icon;

    switch (type) {
      case FeedbackType.success:
        backgroundColor = const Color(0xFF1E3A2F); // Deep emerald dark
        iconColor = const Color(0xFF34D399); // Crisp bright mint green
        icon = Icons.check_circle_rounded;
        break;
      case FeedbackType.error:
        backgroundColor = const Color(0xFF3B1818); // Deep crimson dark
        iconColor = const Color(0xFFF87171); // Crisp bright rose red
        icon = Icons.error_rounded;
        break;
      case FeedbackType.warning:
        backgroundColor = const Color(0xFF382711); // Deep amber dark
        iconColor = const Color(0xFFFBBF24); // Crisp bright gold/amber
        icon = Icons.warning_rounded;
        break;
      case FeedbackType.info:
        backgroundColor = const Color(0xFF132A4A); // Deep navy dark
        iconColor = const Color(0xFF60A5FA); // Crisp sky blue
        icon = Icons.info_rounded;
        break;
      case FeedbackType.loading:
        backgroundColor = const Color(0xFF0F294A); // Deep navy dark
        iconColor = const Color(0xFF38BDF8); // Crisp sky cyan
        icon = Icons.hourglass_top_rounded;
        break;
    }

    final messenger = ScaffoldMessenger.of(context);
    // Dismiss any existing snackbar instantly so user sees the latest action feedback immediately
    messenger.hideCurrentSnackBar();

    messenger.showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: backgroundColor,
        elevation: 6,
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: iconColor.withValues(alpha: 0.35), width: 1),
        ),
        duration: duration,
        content: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: type == FeedbackType.loading
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.4,
                        valueColor: AlwaysStoppedAnimation<Color>(iconColor),
                      ),
                    )
                  : Icon(icon, color: iconColor, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title != null && title.isNotEmpty) ...[
                    Text(
                      title,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 13.5,
                      ),
                    ),
                    const SizedBox(height: 2),
                  ],
                  Text(
                    message,
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.95),
                      fontSize: 13,
                      height: 1.25,
                      fontWeight: title != null ? FontWeight.normal : FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        action: (actionLabel != null && onAction != null)
            ? SnackBarAction(
                label: actionLabel,
                textColor: iconColor,
                onPressed: onAction,
              )
            : null,
      ),
    );
  }

  /// Immediately dismiss any visible acknowledgment
  static void hide(BuildContext context) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
    }
  }
}
