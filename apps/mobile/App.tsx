import { useCallback, useEffect, useState } from "react";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import * as SplashScreen from "expo-splash-screen";
import { useFonts, Archivo_400Regular, Archivo_500Medium, Archivo_700Bold } from "@expo-google-fonts/archivo";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";

import { colors, fonts } from "./theme/theme";
import { getServerHost } from "./lib/settings";
import { useHandsStream } from "./lib/useHandsStream";
import { RailScreen } from "./screens/RailScreen";
import { LineScreen } from "./screens/LineScreen";
import { NeedsYouScreen } from "./screens/NeedsYouScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

// Naming hazard, stated once here rather than re-litigated per file
// (hands#107): "Expo" below always means the React Native tooling (Expo Go,
// expo-font, @expo-google-fonts/*). "the expo" (lowercase, in prose) means
// the hands bus role — this app never talks to that expo, it only reads a
// local hands serve instance.

SplashScreen.preventAutoHideAsync().catch(() => {
  // already hidden, or the native module isn't ready yet — either way,
  // nothing to recover, the first render will hide it via onLayoutRootView
});

const Tab = createBottomTabNavigator();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.ink,
    card: colors.surface,
    border: colors.line,
    primary: colors.accent,
    text: colors.paper,
  },
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Archivo_400Regular,
    Archivo_500Medium,
    Archivo_700Bold,
    JetBrainsMono_400Regular,
  });

  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    void getServerHost().then(setHost);
  }, []);

  const stream = useHandsStream(host ?? "");

  const onReady = useCallback(async () => {
    if (fontsLoaded && host !== null) await SplashScreen.hideAsync();
  }, [fontsLoaded, host]);

  useEffect(() => {
    void onReady();
  }, [onReady]);

  if (!fontsLoaded || host === null) return null;

  return (
    <NavigationContainer theme={navTheme}>
      <Tab.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { fontFamily: fonts.wordmark, color: colors.paper },
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.muted,
          tabBarLabelStyle: { fontFamily: fonts.ui, fontSize: 11 },
        }}
      >
        <Tab.Screen name="Rail" options={{ title: "hands" }}>
          {() => <RailScreen stream={stream} />}
        </Tab.Screen>
        <Tab.Screen name="Line">{() => <LineScreen stream={stream} />}</Tab.Screen>
        <Tab.Screen name="Needs you">{() => <NeedsYouScreen stream={stream} />}</Tab.Screen>
        <Tab.Screen name="Settings">
          {() => <SettingsScreen host={host} onHostChange={setHost} stream={stream} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
