import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { BackButton } from '@/components/back-button';
import { ensureSession } from '@/lib/supabase';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    ensureSession().catch((e) => console.warn('Anonymous sign-in failed', e));
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="report/new"
            options={{ title: 'Report a problem', presentation: 'modal', headerLeft: () => <BackButton /> }}
          />
          <Stack.Screen
            name="report/[id]"
            options={{ title: 'Report', headerBackVisible: false, headerLeft: () => <BackButton /> }}
          />
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
