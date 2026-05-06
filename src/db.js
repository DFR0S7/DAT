// db.js
import { createClient } from '@supabase/supabase-js';
realtime: { transport: ws };
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
