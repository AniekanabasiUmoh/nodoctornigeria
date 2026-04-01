import { Platform } from "react-native";

export const colors = {
  background: "#f4efe6",
  backgroundSoft: "#fbf8f2",
  ink: "#1f2a1f",
  muted: "#617067",
  border: "rgba(31, 42, 31, 0.12)",
  emerald: "#1f6f5f",
  terracotta: "#c96c43",
  gold: "#d2a94f",
  panel: "#fffdf9",
  success: "#1f7a4c",
  danger: "#b2452f",
  code: "#13271f"
};

export const typography = {
  display: Platform.select({ ios: "Georgia", android: "serif", default: "serif" }),
  body: Platform.select({ ios: "System", android: "sans-serif", default: "sans-serif" })
};

