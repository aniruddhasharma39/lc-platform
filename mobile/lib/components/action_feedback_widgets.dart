import 'package:flutter/material.dart';

/// Non-destructive overlay barrier that keeps underlying screen context visible
/// while preventing duplicate actions and back-navigation during an API request.
class ActionBusyOverlay extends StatelessWidget {
  final bool isBusy;
  final String message;
  final Widget child;

  const ActionBusyOverlay({
    super.key,
    required this.isBusy,
    required this.message,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !isBusy,
      child: Stack(
        children: [
          child,
          if (isBusy)
            Positioned.fill(
              child: AbsorbPointer(
                absorbing: true,
                child: Container(
                  color: const Color(0x730F172A),
                  alignment: Alignment.center,
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Container(
                    constraints: const BoxConstraints(maxWidth: 320),
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(14),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x26000000),
                          blurRadius: 18,
                          offset: Offset(0, 8),
                        ),
                      ],
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(strokeWidth: 2.6),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(
                            message,
                            style: const TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF0F172A),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Reusable button content rendering an inline spinner + descriptive operation label
/// during async submission instead of an unlabeled spinner.
class ActionButtonContent extends StatelessWidget {
  final bool isLoading;
  final String loadingLabel;
  final String idleLabel;
  final Color spinnerColor;
  final TextStyle? textStyle;
  final IconData? idleIcon;

  const ActionButtonContent({
    super.key,
    required this.isLoading,
    required this.loadingLabel,
    required this.idleLabel,
    this.spinnerColor = Colors.white,
    this.textStyle,
    this.idleIcon,
  });

  @override
  Widget build(BuildContext context) {
    if (isLoading) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(
              strokeWidth: 2.2,
              valueColor: AlwaysStoppedAnimation<Color>(spinnerColor),
            ),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              loadingLabel,
              overflow: TextOverflow.ellipsis,
              style: textStyle,
            ),
          ),
        ],
      );
    }
    if (idleIcon != null) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(idleIcon, size: 16),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              idleLabel,
              overflow: TextOverflow.ellipsis,
              style: textStyle,
            ),
          ),
        ],
      );
    }
    return Text(idleLabel, style: textStyle);
  }
}

