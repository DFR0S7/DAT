// db.js

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    transport: ws
  }
})
