import { serve } from 'inngest/next';
import { inngest, runPipeline } from '@/src/server/inngest';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runPipeline],
});
