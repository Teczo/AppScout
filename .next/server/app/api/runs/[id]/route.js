(()=>{var a={};a.id=634,a.ids=[634],a.modules={261:a=>{"use strict";a.exports=require("next/dist/shared/lib/router/utils/app-paths")},3295:a=>{"use strict";a.exports=require("next/dist/server/app-render/after-task-async-storage.external.js")},3421:(a,b,c)=>{"use strict";Object.defineProperty(b,"I",{enumerable:!0,get:function(){return g}});let d=c(71237),e=c(55088),f=c(17679);async function g(a,b,c,g){if((0,d.isNodeNextResponse)(b)){var h;b.statusCode=c.status,b.statusMessage=c.statusText;let d=["set-cookie","www-authenticate","proxy-authenticate","vary"];null==(h=c.headers)||h.forEach((a,c)=>{if("x-middleware-set-cookie"!==c.toLowerCase())if("set-cookie"===c.toLowerCase())for(let d of(0,f.splitCookiesString)(a))b.appendHeader(c,d);else{let e=void 0!==b.getHeader(c);(d.includes(c.toLowerCase())||!e)&&b.appendHeader(c,a)}});let{originalResponse:i}=b;c.body&&"HEAD"!==a.method?await (0,e.pipeToNodeResponse)(c.body,i,g):i.end()}}},10846:a=>{"use strict";a.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},19121:a=>{"use strict";a.exports=require("next/dist/server/app-render/action-async-storage.external.js")},28089:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.d(b,{Fk:()=>m,Fy:()=>l,Kg:()=>o,Mh:()=>k,P:()=>h,PF:()=>j,c:()=>q,qB:()=>p,ut:()=>i,xI:()=>n});var e=c(64939),f=a([e]);e=(f.then?(await f)():f)[0];let r=null,s=null;function g(){if(!r){let a=process.env.DATABASE_URL;if(!a)throw Error("Missing required environment variable DATABASE_URL.");r=new e.Pool({connectionString:a,max:5})}return r}let t=`
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
     ORDER BY a.name`,[a])}async function p(a){return(await h("SELECT id, trends_md, ideas_md, created_at FROM reports WHERE channel_id = $1 ORDER BY id DESC LIMIT 1",[a]))[0]}async function q(a){return(await h("SELECT id, channel_name, channel_url FROM channels WHERE id = $1",[a]))[0]}d()}catch(a){d(a)}})},29294:a=>{"use strict";a.exports=require("next/dist/server/app-render/work-async-storage.external.js")},32568:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.r(b),c.d(b,{GET:()=>h,dynamic:()=>i});var e=c(10641),f=c(28089),g=a([f]);f=(g.then?(await g)():g)[0];let i="force-dynamic";async function h(a,{params:b}){try{let{id:a}=await b,c=await (0,f.Mh)(Number(a));if(!c)return e.NextResponse.json({error:"run not found"},{status:404});let d=c.channel_id?await (0,f.Fk)(c.channel_id):null;return e.NextResponse.json({...c,progress:d})}catch(a){return e.NextResponse.json({error:String(a instanceof Error?a.message:a)},{status:500})}}d()}catch(a){d(a)}})},44870:a=>{"use strict";a.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},63033:a=>{"use strict";a.exports=require("next/dist/server/app-render/work-unit-async-storage.external.js")},64939:a=>{"use strict";a.exports=import("pg")},78335:()=>{},86439:a=>{"use strict";a.exports=require("next/dist/shared/lib/no-fallback-error.external")},87987:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.r(b),c.d(b,{handler:()=>x,patchFetch:()=>w,routeModule:()=>y,serverHooks:()=>B,workAsyncStorage:()=>z,workUnitAsyncStorage:()=>A});var e=c(95736),f=c(9117),g=c(4044),h=c(39326),i=c(32324),j=c(261),k=c(54290),l=c(85328),m=c(38928),n=c(46595),o=c(3421),p=c(17679),q=c(41681),r=c(63446),s=c(86439),t=c(51356),u=c(32568),v=a([u]);u=(v.then?(await v)():v)[0];let y=new e.AppRouteRouteModule({definition:{kind:f.RouteKind.APP_ROUTE,page:"/api/runs/[id]/route",pathname:"/api/runs/[id]",filename:"route",bundlePath:"app/api/runs/[id]/route"},distDir:".next",relativeProjectDir:"",resolvedPagePath:"/home/user/AppScout/app/api/runs/[id]/route.ts",nextConfigOutput:"",userland:u}),{workAsyncStorage:z,workUnitAsyncStorage:A,serverHooks:B}=y;function w(){return(0,g.patchFetch)({workAsyncStorage:z,workUnitAsyncStorage:A})}async function x(a,b,c){var d;let e="/api/runs/[id]/route";"/index"===e&&(e="/");let g=await y.prepare(a,b,{srcPage:e,multiZoneDraftMode:!1});if(!g)return b.statusCode=400,b.end("Bad Request"),null==c.waitUntil||c.waitUntil.call(c,Promise.resolve()),null;let{buildId:u,params:v,nextConfig:w,isDraftMode:x,prerenderManifest:z,routerServerContext:A,isOnDemandRevalidate:B,revalidateOnlyGenerated:C,resolvedPathname:D}=g,E=(0,j.normalizeAppPath)(e),F=!!(z.dynamicRoutes[E]||z.routes[D]);if(F&&!x){let a=!!z.routes[D],b=z.dynamicRoutes[E];if(b&&!1===b.fallback&&!a)throw new s.NoFallbackError}let G=null;!F||y.isDev||x||(G=D,G="/index"===G?"/":G);let H=!0===y.isDev||!F,I=F&&!H,J=a.method||"GET",K=(0,i.getTracer)(),L=K.getActiveScopeSpan(),M={params:v,prerenderManifest:z,renderOpts:{experimental:{cacheComponents:!!w.experimental.cacheComponents,authInterrupts:!!w.experimental.authInterrupts},supportsDynamicResponse:H,incrementalCache:(0,h.getRequestMeta)(a,"incrementalCache"),cacheLifeProfiles:null==(d=w.experimental)?void 0:d.cacheLife,isRevalidate:I,waitUntil:c.waitUntil,onClose:a=>{b.on("close",a)},onAfterTaskError:void 0,onInstrumentationRequestError:(b,c,d)=>y.onRequestError(a,b,d,A)},sharedContext:{buildId:u}},N=new k.NodeNextRequest(a),O=new k.NodeNextResponse(b),P=l.NextRequestAdapter.fromNodeNextRequest(N,(0,l.signalFromNodeResponse)(b));try{let d=async c=>y.handle(P,M).finally(()=>{if(!c)return;c.setAttributes({"http.status_code":b.statusCode,"next.rsc":!1});let d=K.getRootSpanAttributes();if(!d)return;if(d.get("next.span_type")!==m.BaseServerSpan.handleRequest)return void console.warn(`Unexpected root span type '${d.get("next.span_type")}'. Please report this Next.js issue https://github.com/vercel/next.js`);let e=d.get("next.route");if(e){let a=`${J} ${e}`;c.setAttributes({"next.route":e,"http.route":e,"next.span_name":a}),c.updateName(a)}else c.updateName(`${J} ${a.url}`)}),g=async g=>{var i,j;let k=async({previousCacheEntry:f})=>{try{if(!(0,h.getRequestMeta)(a,"minimalMode")&&B&&C&&!f)return b.statusCode=404,b.setHeader("x-nextjs-cache","REVALIDATED"),b.end("This page could not be found"),null;let e=await d(g);a.fetchMetrics=M.renderOpts.fetchMetrics;let i=M.renderOpts.pendingWaitUntil;i&&c.waitUntil&&(c.waitUntil(i),i=void 0);let j=M.renderOpts.collectedTags;if(!F)return await (0,o.I)(N,O,e,M.renderOpts.pendingWaitUntil),null;{let a=await e.blob(),b=(0,p.toNodeOutgoingHttpHeaders)(e.headers);j&&(b[r.NEXT_CACHE_TAGS_HEADER]=j),!b["content-type"]&&a.type&&(b["content-type"]=a.type);let c=void 0!==M.renderOpts.collectedRevalidate&&!(M.renderOpts.collectedRevalidate>=r.INFINITE_CACHE)&&M.renderOpts.collectedRevalidate,d=void 0===M.renderOpts.collectedExpire||M.renderOpts.collectedExpire>=r.INFINITE_CACHE?void 0:M.renderOpts.collectedExpire;return{value:{kind:t.CachedRouteKind.APP_ROUTE,status:e.status,body:Buffer.from(await a.arrayBuffer()),headers:b},cacheControl:{revalidate:c,expire:d}}}}catch(b){throw(null==f?void 0:f.isStale)&&await y.onRequestError(a,b,{routerKind:"App Router",routePath:e,routeType:"route",revalidateReason:(0,n.c)({isRevalidate:I,isOnDemandRevalidate:B})},A),b}},l=await y.handleResponse({req:a,nextConfig:w,cacheKey:G,routeKind:f.RouteKind.APP_ROUTE,isFallback:!1,prerenderManifest:z,isRoutePPREnabled:!1,isOnDemandRevalidate:B,revalidateOnlyGenerated:C,responseGenerator:k,waitUntil:c.waitUntil});if(!F)return null;if((null==l||null==(i=l.value)?void 0:i.kind)!==t.CachedRouteKind.APP_ROUTE)throw Object.defineProperty(Error(`Invariant: app-route received invalid cache entry ${null==l||null==(j=l.value)?void 0:j.kind}`),"__NEXT_ERROR_CODE",{value:"E701",enumerable:!1,configurable:!0});(0,h.getRequestMeta)(a,"minimalMode")||b.setHeader("x-nextjs-cache",B?"REVALIDATED":l.isMiss?"MISS":l.isStale?"STALE":"HIT"),x&&b.setHeader("Cache-Control","private, no-cache, no-store, max-age=0, must-revalidate");let m=(0,p.fromNodeOutgoingHttpHeaders)(l.value.headers);return(0,h.getRequestMeta)(a,"minimalMode")&&F||m.delete(r.NEXT_CACHE_TAGS_HEADER),!l.cacheControl||b.getHeader("Cache-Control")||m.get("Cache-Control")||m.set("Cache-Control",(0,q.getCacheControlHeader)(l.cacheControl)),await (0,o.I)(N,O,new Response(l.value.body,{headers:m,status:l.value.status||200})),null};L?await g(L):await K.withPropagatedContext(a.headers,()=>K.trace(m.BaseServerSpan.handleRequest,{spanName:`${J} ${a.url}`,kind:i.SpanKind.SERVER,attributes:{"http.method":J,"http.target":a.url}},g))}catch(b){if(b instanceof s.NoFallbackError||await y.onRequestError(a,b,{routerKind:"App Router",routePath:E,routeType:"route",revalidateReason:(0,n.c)({isRevalidate:I,isOnDemandRevalidate:B})}),F)throw b;return await (0,o.I)(N,O,new Response(null,{status:500})),null}}d()}catch(a){d(a)}})},95736:(a,b,c)=>{"use strict";a.exports=c(44870)},96487:()=>{}};var b=require("../../../../webpack-runtime.js");b.C(a);var c=b.X(0,[873,641],()=>b(b.s=87987));module.exports=c})();