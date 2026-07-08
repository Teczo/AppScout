exports.id=939,exports.ids=[939],exports.modules={11354:(a,b,c)=>{"use strict";function d(a){return a.toLowerCase().replace(/\s+/g,"")}c.d(b,{q:()=>d})},15831:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.d(b,{CZ:()=>x,DF:()=>A,DU:()=>t,Ut:()=>v,a:()=>y,aG:()=>s,hY:()=>B,jK:()=>w});var e=c(48666),f=c(51145),g=c(74780),h=c(73535),i=c(43110),j=c(28558),k=c(11354),l=c(35753),m=c(28089),n=a([m]);m=(n.then?(await n)():n)[0];let C={info:a=>console.log(a),warn:a=>console.warn(a),error:a=>console.error(a)};function o(a){let b=process.env[a];if(!b)throw Error(`Missing required environment variable ${a}.`);return b}function p(){return new e.Ay({apiKey:o("ANTHROPIC_API_KEY"),maxRetries:3})}function q(){return Number.parseInt(process.env.MAX_VIDEOS??"100",10)}function r(){return Number.parseInt(process.env.MAX_RESEARCH_ITERATIONS??"8",10)}async function s(a){let b=new l.Z(o("YOUTUBE_API_KEY")),c=await b.resolveChannel(a),d=await b.listVideos(c.uploadsPlaylistId,q()),e=.014*d.length+d.length*(.01*r()+.11)+.2;return{channelName:c.title,videoCount:d.length,estimatedCostUsd:e}}async function t(a){let b=new l.Z(o("YOUTUBE_API_KEY")),c=await b.resolveChannel(a),d=await b.listVideos(c.uploadsPlaylistId,q());return{channelId:await (0,m.Fy)(a,c.title,d.length),channelName:c.title,videos:d}}function u(a){let b=String(a instanceof Error?a.message:a).toLowerCase();return b.includes("transcript is disabled")||b.includes("transcripts disabled")||b.includes("no transcript")||b.includes("transcript not available")||b.includes("unavailable")}async function v(a,b){let c={ok:0,unavailable:0,error:0,skipped:0};for(let d of b){let b,e=await (0,m.P)("SELECT transcript_status FROM videos WHERE video_id = $1",[d.videoId]);if(e[0]?.transcript_status==="ok"){c.skipped++;continue}let f=null;try{b=(f=await (0,i.b)(`transcript ${d.videoId}`,()=>(0,g.Q)(d.videoId),{shouldRetry:a=>!u(a)})).length>0?"ok":"unavailable"}catch(a){b=u(a)?"unavailable":"error"}c[b]++,await (0,m.P)(`INSERT INTO videos (channel_id, video_id, title, published_at, transcript_status, transcript_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (video_id) DO UPDATE SET
         title = EXCLUDED.title, published_at = EXCLUDED.published_at,
         transcript_status = EXCLUDED.transcript_status, transcript_text = EXCLUDED.transcript_text`,[a,d.videoId,d.title,d.publishedAt,b,f])}return c}async function w(a){let b=await (0,m.P)(`SELECT id, video_id, transcript_text FROM videos
     WHERE transcript_status = 'ok' AND extraction_status = 'pending'
     ORDER BY id LIMIT $1`,[a]);if(0===b.length)return 0;let c=p(),d={inputTokens:0,outputTokens:0};for(let a of b)try{for(let b of(await (0,f.CY)(c,a.transcript_text.slice(0,f.wX),d)))await (0,m.P)(`INSERT INTO apps (video_id, name, normalized_name, description, niche, claimed_revenue, founder, extraction_confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,[a.id,b.name,(0,k.q)(b.name),b.description,b.niche,b.claimed_revenue,b.founder,b.extraction_confidence]);await (0,m.P)("UPDATE videos SET extraction_status = 'done' WHERE id = $1",[a.id])}catch(b){console.error(`extract failed for ${a.video_id}: ${String(b).slice(0,300)}`),await (0,m.P)("UPDATE videos SET extraction_status = 'failed' WHERE id = $1",[a.id])}return b.length}async function x(a){return(await (0,m.P)(`SELECT MIN(a.id) AS id
     FROM apps a JOIN videos v ON v.id = a.video_id
     WHERE v.channel_id = $1
       AND a.normalized_name NOT IN (
         SELECT a2.normalized_name FROM apps a2 JOIN research r ON r.app_id = a2.id
       )
     GROUP BY a.normalized_name`,[a])).map(a=>a.id)}async function y(a){if((await (0,m.P)("SELECT 1 FROM research WHERE app_id = $1",[a])).length>0)return"skipped";let b=(await (0,m.P)(`SELECT a.id, a.name, a.description, a.niche, a.claimed_revenue, a.founder, a.normalized_name,
            (SELECT COUNT(*) FROM apps d WHERE d.normalized_name = a.normalized_name)::int AS video_count
     FROM apps a WHERE a.id = $1`,[a]))[0];if(!b)throw Error(`app ${a} not found`);let{output:c}=await (0,h.zU)(p(),b,r(),{inputTokens:0,outputTokens:0},C);return await (0,m.P)(`INSERT INTO research (app_id, verified_revenue, revenue_source_url, target_market, pricing_model,
                           launch_year, distribution_channel, success_factors, research_status, sources_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,[a,c.verified_revenue,c.revenue_source_url,c.target_market,c.pricing_model,c.launch_year,c.distribution_channel,c.success_factors?JSON.stringify(c.success_factors):null,c.research_status,JSON.stringify({sources:c.sources,notes:c.notes})]),c.research_status}async function z(a){return(await (0,m.P)(`SELECT a.name, a.description, a.niche, a.claimed_revenue, a.founder, a.extraction_confidence,
            r.verified_revenue, r.revenue_source_url, r.target_market, r.pricing_model,
            r.launch_year, r.distribution_channel, r.success_factors, r.research_status, r.sources_json
     FROM research r
     JOIN apps a ON a.id = r.app_id
     JOIN videos v ON v.id = a.video_id
     WHERE v.channel_id = $1
     ORDER BY a.name`,[a])).map(a=>({...a,success_factors:a.success_factors?JSON.parse(a.success_factors):null,sources_json:a.sources_json?JSON.parse(a.sources_json):null}))}async function A(a){let b=await z(a);if(0===b.length||(await (0,m.P)(`SELECT 1 FROM reports
     WHERE channel_id = $1
       AND created_at >= (SELECT MAX(r.researched_at) FROM research r
                          JOIN apps a ON a.id = r.app_id JOIN videos v ON v.id = a.video_id
                          WHERE v.channel_id = $1)`,[a])).length>0)return null;let c=await (0,j.dP)(p(),b,{inputTokens:0,outputTokens:0});return(await (0,m.P)("INSERT INTO reports (channel_id, trends_md, ideas_md) VALUES ($1, $2, $3) RETURNING id",[a,c.trends_md,c.ideas_md]))[0].id}async function B(a,b){let c=await z(a);if(0===c.length)return"No research findings exist for this channel yet — run the pipeline first.";let d=p();return(await d.messages.create({model:"claude-sonnet-4-6",max_tokens:2e3,system:"You answer questions about a corpus of researched apps from a YouTube channel. Use only the corpus provided — cite app names, and distinguish verified from claimed revenue. If the corpus does not contain the answer, say so.",messages:[{role:"user",content:`<research_corpus>
${JSON.stringify(c,null,1)}
</research_corpus>

Question: ${b}`}]})).content.filter(a=>"text"===a.type).map(a=>a.text).join("\n")}d()}catch(a){d(a)}})},28089:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.d(b,{Fk:()=>m,Fy:()=>l,Kg:()=>o,Mh:()=>k,P:()=>h,PF:()=>j,c:()=>q,qB:()=>p,ut:()=>i,xI:()=>n});var e=c(64939),f=a([e]);e=(f.then?(await f)():f)[0];let r=null,s=null;function g(){if(!r){let a=process.env.DATABASE_URL;if(!a)throw Error("Missing required environment variable DATABASE_URL.");r=new e.Pool({connectionString:a,max:5})}return r}let t=`
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  channel_url TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  video_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  video_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  transcript_status TEXT NOT NULL CHECK (transcript_status IN ('ok','unavailable','error')),
  transcript_text TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending','done','failed','skipped'))
);

CREATE TABLE IF NOT EXISTS apps (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  niche TEXT,
  claimed_revenue TEXT,
  founder TEXT,
  extraction_confidence TEXT NOT NULL CHECK (extraction_confidence IN ('high','medium','low'))
);
CREATE INDEX IF NOT EXISTS idx_apps_normalized_name ON apps(normalized_name);

CREATE TABLE IF NOT EXISTS research (
  id SERIAL PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id),
  verified_revenue TEXT,
  revenue_source_url TEXT,
  target_market TEXT,
  pricing_model TEXT,
  launch_year INTEGER,
  distribution_channel TEXT,
  success_factors TEXT,
  research_status TEXT NOT NULL CHECK (research_status IN ('complete','partial','not_found')),
  sources_json TEXT,
  researched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  trends_md TEXT NOT NULL,
  ideas_md TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  channel_url TEXT NOT NULL,
  channel_id INTEGER REFERENCES channels(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','error')),
  stage TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;async function h(a,b=[]){return s||(s=g().query(t).then(()=>void 0)),await s,(await g().query(a,b)).rows}async function i(a){return(await h("INSERT INTO runs (channel_url) VALUES ($1) RETURNING id",[a]))[0].id}async function j(a,b){await h(`UPDATE runs SET
       status = COALESCE($2, status),
       stage = COALESCE($3, stage),
       channel_id = COALESCE($4, channel_id),
       error = COALESCE($5, error),
       updated_at = now()
     WHERE id = $1`,[a,b.status??null,b.stage??null,b.channel_id??null,b.error??null])}async function k(a){return(await h("SELECT * FROM runs WHERE id = $1",[a]))[0]}async function l(a,b,c){return(await h(`INSERT INTO channels (channel_url, channel_name, video_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_url) DO UPDATE SET
       channel_name = EXCLUDED.channel_name,
       video_count = EXCLUDED.video_count,
       ingested_at = now()
     RETURNING id`,[a,b,c]))[0].id}async function m(a){let b=async b=>{let c=await h(b,[a]);return Object.fromEntries(c.map(a=>[a.key,Number(a.n)]))},c=async b=>Number((await h(b,[a]))[0]?.n??0);return{videos:await c("SELECT COUNT(*) AS n FROM videos WHERE channel_id = $1"),transcripts:await b("SELECT transcript_status AS key, COUNT(*) AS n FROM videos WHERE channel_id = $1 GROUP BY 1"),extraction:await b("SELECT extraction_status AS key, COUNT(*) AS n FROM videos WHERE channel_id = $1 GROUP BY 1"),appsTotal:await c("SELECT COUNT(*) AS n FROM apps a JOIN videos v ON v.id = a.video_id WHERE v.channel_id = $1"),appsUnique:await c(`SELECT COUNT(DISTINCT a.normalized_name) AS n FROM apps a
       JOIN videos v ON v.id = a.video_id WHERE v.channel_id = $1`),research:await b(`SELECT r.research_status AS key, COUNT(*) AS n FROM research r
       JOIN apps a ON a.id = r.app_id JOIN videos v ON v.id = a.video_id
       WHERE v.channel_id = $1 GROUP BY 1`),reports:await c("SELECT COUNT(*) AS n FROM reports WHERE channel_id = $1")}}async function n(){return h(`SELECT c.id, c.channel_url, c.channel_name, c.video_count,
            (SELECT COUNT(DISTINCT a.normalized_name) FROM apps a JOIN videos v ON v.id = a.video_id
             WHERE v.channel_id = c.id)::int AS apps_unique,
            EXISTS (SELECT 1 FROM reports r WHERE r.channel_id = c.id) AS has_report
     FROM channels c ORDER BY c.ingested_at DESC`)}async function o(a){return h(`SELECT a.name, a.niche, a.description, a.founder, a.extraction_confidence, a.claimed_revenue,
            (SELECT COUNT(*) FROM apps d JOIN videos dv ON dv.id = d.video_id
             WHERE d.normalized_name = a.normalized_name AND dv.channel_id = $1)::int AS video_count,
            r.research_status, r.verified_revenue, r.revenue_source_url, r.target_market,
            r.pricing_model, r.launch_year, r.distribution_channel, r.success_factors, r.sources_json
     FROM apps a
     JOIN videos v ON v.id = a.video_id
     LEFT JOIN research r ON r.app_id = a.id
     WHERE v.channel_id = $1
       AND a.id = (SELECT MIN(a2.id) FROM apps a2 WHERE a2.normalized_name = a.normalized_name)
     ORDER BY a.name`,[a])}async function p(a){return(await h("SELECT id, trends_md, ideas_md, created_at FROM reports WHERE channel_id = $1 ORDER BY id DESC LIMIT 1",[a]))[0]}async function q(a){return(await h("SELECT id, channel_name, channel_url FROM channels WHERE id = $1",[a]))[0]}d()}catch(a){d(a)}})},28558:(a,b,c)=>{"use strict";c.d(b,{dP:()=>h}),c(48666),c(73024),c(76760);var d=c(2995);let e=d.Ik({trends_md:d.Yj().min(1),ideas_md:d.Yj().min(1)}),f={name:"record_report",description:"Record the final synthesis report as two markdown sections.",input_schema:{type:"object",properties:{trends_md:{type:"string",description:"Markdown for the Trends section: patterns across niche, revenue band, pricing, distribution, founder type, time-to-revenue. Every pattern must cite specific apps from the data as evidence."},ideas_md:{type:"string",description:"Markdown for the Ideas section: 3-5 new app ideas, each justified by the identified trends, with target market and suggested distribution channel."}},required:["trends_md","ideas_md"],additionalProperties:!1}},g=`You synthesize research about apps featured on a YouTube channel into a trends report.

You receive the full research corpus as JSON: one entry per app with extraction data from the videos (claimed revenue, niche) and verified research findings (revenue, target market, pricing, launch year, distribution channel, success factors, sources, research status).

Produce two markdown sections via the record_report tool:

1. trends_md — patterns across niche, revenue band, pricing model, distribution channel, founder type, and time-to-revenue. Every pattern must reference specific apps from the corpus as evidence. Treat verified and merely-claimed revenue differently and say which is which. Ignore not_found apps except as a signal (e.g. hype without substance).

2. ideas_md — 3 to 5 new app ideas. Each idea must be justified by the trends you identified (cite them), with a target market and a suggested distribution channel. Ground every idea in the data — no generic ideas that could be written without this corpus.

Use only the provided data. Do not invent apps, figures, or sources.`;async function h(a,b,c){let d=[{role:"user",content:`Synthesize the trends report from this research corpus:

<research_corpus>
${JSON.stringify(b,null,1)}
</research_corpus>`}];for(let b=1;b<=2;b++){let h=await a.messages.create({model:"claude-sonnet-4-6",max_tokens:16e3,system:g,tools:[f],tool_choice:{type:"tool",name:"record_report"},messages:d});c.inputTokens+=h.usage.input_tokens,c.outputTokens+=h.usage.output_tokens;let i=h.content.find(a=>"tool_use"===a.type&&"record_report"===a.name);if(!i)throw Error(`No record_report tool call in response (stop_reason=${h.stop_reason})`);let j=e.safeParse(i.input);if(j.success)return j.data;if(2===b)throw Error(`Report failed schema validation after retry: ${j.error.message.slice(0,400)}`);d.push({role:"assistant",content:h.content},{role:"user",content:[{type:"tool_result",tool_use_id:i.id,is_error:!0,content:`Your record_report input failed schema validation:
${j.error.message}
Call record_report again with valid input.`}]})}throw Error("unreachable")}},35753:(a,b,c)=>{"use strict";c.d(b,{Z:()=>e});var d=c(43110);class e{constructor(a,b=fetch){this.apiKey=a,this.fetchFn=b}async get(a,b){let c=new URL(`https://www.googleapis.com/youtube/v3/${a}`);for(let[a,d]of Object.entries(b))c.searchParams.set(a,d);return c.searchParams.set("key",this.apiKey),(0,d.b)(`YouTube API ${a}`,async()=>{let a=await this.fetchFn(c.toString());if(!a.ok){let b=await a.text().catch(()=>"");throw Error(`HTTP ${a.status}: ${b.slice(0,500)}`)}return a.json()})}async resolveChannel(a){let b,c=new URL(a).pathname.replace(/\/+$/,""),d=c.match(/\/channel\/(UC[\w-]+)/),e=c.match(/\/(@[\w.-]+)/),f=c.match(/\/(?:c|user)\/([^/]+)/),g="snippet,contentDetails";if(d)b=await this.get("channels",{part:g,id:d[1]});else if(e)b=await this.get("channels",{part:g,forHandle:e[1]});else if(f)b=await this.get("channels",{part:g,forHandle:`@${f[1]}`}),b.items?.length||(b=await this.get("channels",{part:g,forUsername:f[1]}));else throw Error(`Unrecognized channel URL format: ${a} (expected /channel/UC..., /@handle, /c/name, or /user/name)`);let h=b.items?.[0];if(!h)throw Error(`Channel not found for URL: ${a}`);return{channelId:h.id,title:h.snippet.title,uploadsPlaylistId:h.contentDetails.relatedPlaylists.uploads}}async listVideos(a,b){let c,d=[];for(;d.length<b;){let e={part:"snippet,contentDetails",playlistId:a,maxResults:String(Math.min(50,b-d.length))};c&&(e.pageToken=c);let f=await this.get("playlistItems",e);for(let a of f.items??[])d.push({videoId:a.contentDetails.videoId,title:a.snippet.title,publishedAt:a.contentDetails.videoPublishedAt??a.snippet.publishedAt});if(!(c=f.nextPageToken))break}return d.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)),d.slice(0,b)}}},43110:(a,b,c)=>{"use strict";async function d(a,b,c={}){let e,f=c.maxAttempts??3,g=c.baseDelayMs??1e3;for(let a=1;a<=f;a++)try{return await b()}catch(d){if(c.shouldRetry&&!c.shouldRetry(d))throw d;if(e=d,a===f)break;c.onRetry?.(d,a);let b=g*2**(a-1);await new Promise(a=>setTimeout(a,b))}throw Error(`${a} failed after ${f} attempts: ${String(e)}`,{cause:e})}c.d(b,{b:()=>d})},51145:(a,b,c)=>{"use strict";c.d(b,{CY:()=>j,wX:()=>e}),c(48666);var d=c(2995);let e=5e4,f=d.Ik({name:d.Yj().min(1),description:d.Yj().nullable(),niche:d.Yj().nullable(),claimed_revenue:d.Yj().nullable(),founder:d.Yj().nullable(),extraction_confidence:d.k5(["high","medium","low"])}),g=d.Ik({apps:d.YO(f)}),h={name:"record_apps",description:"Record every distinct app/product discussed in the video transcript. Call with an empty apps array if the video discusses no specific app.",input_schema:{type:"object",properties:{apps:{type:"array",items:{type:"object",properties:{name:{type:"string",description:"The app/product name"},description:{type:["string","null"],description:"One-sentence description of what the app does"},niche:{type:["string","null"],description:'Market niche/category, e.g. "AI writing tools"'},claimed_revenue:{type:["string","null"],description:'Revenue figure exactly as claimed in the video, verbatim (e.g. "$40k MRR"). Null if none stated.'},founder:{type:["string","null"],description:"Founder name if mentioned"},extraction_confidence:{type:"string",enum:["high","medium","low"],description:"How confident you are this is a real, distinct app discussed in the video"}},required:["name","description","niche","claimed_revenue","founder","extraction_confidence"],additionalProperties:!1}}},required:["apps"],additionalProperties:!1}},i=`You extract structured data about apps from YouTube video transcripts.

The transcripts come from channels that discuss indie apps, SaaS products, and startups. For the transcript you are given:

- Identify every distinct app or software product that is actually discussed (not merely name-dropped in passing as a comparison or sponsor).
- Record each one with the record_apps tool.
- If the video discusses no specific app or product, call record_apps with an empty apps array.
- claimed_revenue must contain revenue figures exactly as claimed in the video, verbatim (e.g. "$40k MRR", "seven figures a year"). Do not convert or normalize them. Null if no figure is stated.
- Only include information stated in the transcript. Never fill gaps from prior knowledge. Use null for anything not mentioned.
- Set extraction_confidence: high = clearly a real app discussed at length; medium = discussed briefly or ambiguously; low = uncertain it is a distinct app.`;async function j(a,b,c){let d=[{role:"user",content:`Extract all apps from this video transcript:

<transcript>
${b}
</transcript>`}];for(let b=1;b<=2;b++){let e=await a.messages.create({model:"claude-haiku-4-5",max_tokens:4096,system:i,tools:[h],tool_choice:{type:"tool",name:"record_apps"},messages:d});c.inputTokens+=e.usage.input_tokens,c.outputTokens+=e.usage.output_tokens;let f=e.content.find(a=>"tool_use"===a.type&&"record_apps"===a.name);if(!f)throw Error(`No record_apps tool call in response (stop_reason=${e.stop_reason})`);let j=g.safeParse(f.input);if(j.success)return j.data.apps;if(2===b)throw Error(`Schema validation failed after retry: ${j.error.message.slice(0,500)}`);d.push({role:"assistant",content:e.content},{role:"user",content:[{type:"tool_result",tool_use_id:f.id,is_error:!0,content:`Your record_apps input failed schema validation:
${j.error.message}
Call record_apps again with valid input.`}]})}throw Error("unreachable")}},73535:(a,b,c)=>{"use strict";c.d(b,{zU:()=>g}),c(48666);var d=c(2995);let e=d.Ik({research_status:d.k5(["complete","partial","not_found"]),app_exists:d.zM(),verified_revenue:d.Yj().nullable(),revenue_source_url:d.Yj().nullable(),target_market:d.Yj().nullable(),pricing_model:d.Yj().nullable(),launch_year:d.ai().int().nullable(),distribution_channel:d.Yj().nullable(),success_factors:d.YO(d.Yj()).max(3).nullable(),sources:d.YO(d.Ik({field:d.Yj(),url:d.Yj()})),notes:d.Yj().nullable()}),f={name:"record_research",description:"Record the final research findings for the app. Call this exactly once, when the checklist is answered or you must stop (cap reached / app not found).",input_schema:{type:"object",properties:{research_status:{type:"string",enum:["complete","partial","not_found"],description:"complete = all checklist items answered with sources; partial = some answered; not_found = could not confirm the app exists"},app_exists:{type:"boolean",description:"Whether you confirmed the app exists (official site / app store listing)"},verified_revenue:{type:["string","null"],description:"Revenue (MRR/ARR) verified by an independent source (founder post, Indie Hackers, press). Null if no independent source found — never copy the video claim here."},revenue_source_url:{type:["string","null"],description:"URL of the independent revenue source. Required if verified_revenue is set."},target_market:{type:["string","null"],description:"Target market / customer profile"},pricing_model:{type:["string","null"],description:"e.g. freemium, $19/mo subscription, one-time purchase"},launch_year:{type:["integer","null"],description:"Year the app launched"},distribution_channel:{type:["string","null"],description:"Primary distribution channel (SEO, TikTok, Product Hunt, ...)"},success_factors:{type:["array","null"],items:{type:"string"},maxItems:3,description:"2-3 stated success factors, from sources"},sources:{type:"array",items:{type:"object",properties:{field:{type:"string",description:'Which field this source supports, e.g. "pricing_model"'},url:{type:"string"}},required:["field","url"],additionalProperties:!1},description:"One entry per non-null factual field. A field without a source must be null."},notes:{type:["string","null"],description:"Caveats, e.g. 'unverified — claimed $40k MRR in video' when no independent revenue source was found."}},required:["research_status","app_exists","verified_revenue","revenue_source_url","target_market","pricing_model","launch_year","distribution_channel","success_factors","sources","notes"],additionalProperties:!1}};async function g(a,b,c,d,g){let h=[{type:"web_search_20260209",name:"web_search",max_uses:c},f],i=[`App name: ${b.name}`,b.description?`Description (from video): ${b.description}`:null,b.niche?`Niche: ${b.niche}`:null,b.claimed_revenue?`Revenue claimed in video: ${b.claimed_revenue}`:null,b.founder?`Founder (from video): ${b.founder}`:null,`Mentioned in ${b.video_count} video(s).`].filter(Boolean).join("\n"),j=[{role:"user",content:`Research this app:

${i}`}],k=0,l=!1,m=0,n=c+6;for(let f=0;f<n;f++){let f=await a.messages.create({model:"claude-sonnet-4-6",max_tokens:8e3,thinking:{type:"adaptive"},system:`You are a research agent verifying facts about an app mentioned in a YouTube video. Use the web_search tool to work through this checklist:

1. Confirm the app exists (official site / app store listing)
2. Verified revenue (MRR/ARR) with a source URL — founder posts, Indie Hackers, press
3. Target market / customer profile
4. Pricing model
5. Launch year
6. Primary distribution channel (SEO, TikTok, Product Hunt, etc.)
7. 2-3 stated success factors

Rules (mandatory):
- You have at most ${c} web searches. If all checklist items are answered, call record_research immediately — do not keep searching.
- If after 3 searches nothing confirms the app exists, stop and call record_research with research_status='not_found'. Do not keep reformulating queries.
- Distinguish claimed vs verified revenue. The video's claim is NOT verification. If no independent source confirms revenue, set verified_revenue=null and put "unverified — claimed <figure> in video" in notes.
- Every non-null factual field must have a matching entry in sources with a real URL you actually saw. No source -> set the field to null. Never fill gaps from your prior knowledge.
- Finish by calling record_research exactly once.`,tools:h,messages:j});if(d.inputTokens+=f.usage.input_tokens,d.outputTokens+=f.usage.output_tokens,k+=f.content.filter(a=>"server_tool_use"===a.type&&"web_search"===a.name).length,"pause_turn"===f.stop_reason){j.push({role:"assistant",content:f.content});continue}let i=f.content.find(a=>"tool_use"===a.type&&"record_research"===a.name);if(i){let a=e.safeParse(i.input);if(a.success)return{output:a.data,searches:k};if(l)throw Error(`record_research failed validation after retry: ${a.error.message.slice(0,400)}`);l=!0,j.push({role:"assistant",content:f.content},{role:"user",content:[{type:"tool_result",tool_use_id:i.id,is_error:!0,content:`Your record_research input failed schema validation:
${a.error.message}
Call record_research again with valid input.`}]});continue}if(m>=2)break;m++,g.warn(`Research: "${b.name}" ended turn without record_research; nudging (${m}/2)`),j.push({role:"assistant",content:f.content},{role:"user",content:'Stop searching. Call record_research now with everything found so far (use research_status="partial" if the checklist is incomplete, or "not_found" if the app could not be confirmed).'})}throw Error(`agent loop exhausted ${n} calls without a valid record_research output`)}},74780:(a,b,c)=>{"use strict";c.d(b,{Q:()=>e});var d=c(33044);c(87550),c(73024),c(76760);let e=async a=>(await d.Ql.fetchTranscript(a)).map(a=>a.text).join(" ").trim()},78335:()=>{},96487:()=>{}};