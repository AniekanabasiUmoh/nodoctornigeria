import { PropsWithChildren, ReactNode } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, typography } from "@/lib/theme";

type ScreenShellProps = PropsWithChildren<{
  eyebrow: string;
  title: string;
  subtitle: string;
  footer?: ReactNode;
}>;

export function ScreenShell({ eyebrow, title, subtitle, children, footer }: ScreenShellProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerCard}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <View style={styles.body}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  content: {
    padding: 20,
    gap: 18
  },
  headerCard: {
    borderRadius: 28,
    padding: 22,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border
  },
  eyebrow: {
    color: colors.emerald,
    textTransform: "uppercase",
    letterSpacing: 1.1,
    fontSize: 12,
    marginBottom: 10,
    fontFamily: typography.body
  },
  title: {
    color: colors.ink,
    fontSize: 36,
    lineHeight: 38,
    fontFamily: typography.display,
    marginBottom: 10
  },
  subtitle: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: typography.body
  },
  body: {
    gap: 16
  },
  footer: {
    paddingBottom: 24
  }
});

