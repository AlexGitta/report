import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * In dev, local Supabase runs on the same machine as Metro. Reuse Metro's host
 * (the LAN IP Expo Go / the emulator already reaches) so phones and emulators
 * work without editing env files. EXPO_PUBLIC_SUPABASE_URL overrides this.
 */
function devSupabaseUrl() {
  const host = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
  return `http://${host}:54321`;
}

export const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || devSupabaseUrl();
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '';

// Static web rendering runs without `window`; skip persistence there.
const canPersist = Platform.OS !== 'web' || typeof window !== 'undefined';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage: canPersist ? AsyncStorage : undefined,
    persistSession: canPersist,
    autoRefreshToken: canPersist,
    detectSessionInUrl: false,
  },
});

/** Guests get an anonymous session so they can upload photos and follow reports. */
export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: anon, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return anon.session;
}
