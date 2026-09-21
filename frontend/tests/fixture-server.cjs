// Isolated in-memory API for visual development. Never use as a production backend.
const http = require("node:http"); const fs = require("node:fs"); const path = require("node:path"); const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../dist"); const port = Number(process.env.FIXTURE_PORT || 5180);
const rev = (n) => n.toString(16).padStart(64, "0");
let revision = 1, siteRevision = 1;
let aiProposal = null;
let favorite = {is_favorite:false,notifications_enabled:false};
let campaigns = [];
let restaurant = { id: randomUUID(), public_id: "test-point", name: "Кофейня Север", address: "Москва, Покровка, 12", description: "Кофе и свежая выпечка", role: "owner", menu_id: randomUUID(), draft_version_id: randomUUID(), current_published_version_id: null };
const size1 = randomUUID(), size2 = randomUUID();
const defaultConfig = () => ({ variants: [], default_variant_id: null, modifier_groups: [] });
const item = (name, price, weight) => ({ id: randomUUID(), name, description: null, image_url: null, price_minor: price, currency: "RUB", weight_text: weight, ingredients: null, allergens: [], is_available: true, source_confidence: null, configuration: defaultConfig() });
const latte = item("Латте", 19000, "250 мл"); latte.description = "Эспрессо и молочная пена";
const option = (name, price, qty=0) => ({ id: randomUUID(), name, price_minor: price, min_quantity: 0, max_quantity: 1, default_quantity: qty, is_available: true, price_by_variant: {} });
latte.configuration = { variants: [{ id:size1,name:"250 мл",price_minor:19000,weight_text:"250 мл",is_available:true },{ id:size2,name:"350 мл",price_minor:23000,weight_text:"350 мл",is_available:true }], default_variant_id:size1, modifier_groups:[{ id:randomUUID(),name:"Молоко",min_quantity:1,max_quantity:1,options:[option("Обычное",0,1),option("Овсяное",5000)] },{ id:randomUUID(),name:"Сироп",min_quantity:0,max_quantity:2,options:[{...option("Карамель",3000),max_quantity:2}] }] };
let sections = [{id:randomUUID(),name:"Кофе",items:[latte,item("Капучино",18000,"250 мл"),item("Флэт уайт",21000,"200 мл"),item("Американо",14000,"250 мл")]},{id:randomUUID(),name:"Выпечка",items:[item("Круассан",17000,"80 г"),item("Синнабон",22000,"120 г")]}];
let published = [];
let site = {template:"cafe",theme_mode:"light",primary_color:"#C84F2F",background_color:"#FFF2E2",surface_color:"#FFFDF8",text_color:"#302117",icon_color:"#C84F2F",background_image_url:null,background_overlay:12,font_scale:1,tagline:null,about:null,phone:null,hours:"Ежедневно 09:00–21:00",booking_url:null,logo_url:null,cover_url:null,gallery_urls:[],blocks:["hero","about","menu","gallery","contacts"].map(kind=>({kind,visible:true,title:null}))};
const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url,"http://127.0.0.1"); const p=url.pathname; let text=""; for await(const chunk of req) { text+=chunk; if(text.length>5000000) throw new Error("Too large"); } const body=text?JSON.parse(text):{};
    const json=(data,status=200)=>{res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));};
    if(p.startsWith("/api/")) {
      if(p.endsWith("/auth/me"))return json({id:"test-user",max_user_id:1,display_name:"Демо · без базы"});
      if(p.includes("/health/"))return json({status:"ok",service:"In-memory visual fixture"});
      if(p==="/api/v1/restaurants") { if(req.method==="POST"){restaurant={...restaurant,...body};return json(restaurant,201);}return json([restaurant]); }
      if(p.endsWith("/restaurants/"+restaurant.id)&&req.method==="PATCH"){restaurant={...restaurant,...body};return json(restaurant);}
      if(p.endsWith("/menu/quote")) {
        const product=published.flatMap(s=>s.items).find(i=>i.id===body.item_id); if(!product)return json({detail:"Меню обновилось"},409);
        const c=product.configuration, selected=new Map(body.modifiers.map(s=>[s.option_id,s.quantity])); let price=product.price_minor;
        if(c.variants.length){const v=c.variants.find(v=>v.id===body.variant_id&&v.is_available);if(!v)return json({detail:"Выберите размер"},422);price=v.price_minor;}
        for(const g of c.modifier_groups){const count=g.options.reduce((n,o)=>n+(selected.get(o.id)||0),0);if(count<g.min_quantity||count>g.max_quantity)return json({detail:`«${g.name}»: выберите от ${g.min_quantity} до ${g.max_quantity}`},422);for(const o of g.options)price+=(selected.get(o.id)||0)*(o.price_by_variant[body.variant_id]??o.price_minor);}
        return json({unit_price_minor:price,total_price_minor:price,currency:"RUB",quantity:1});
      }
      if(p.endsWith("/favorite")){if(req.method==="PUT")favorite=body.is_favorite?{is_favorite:true,notifications_enabled:Boolean(body.notifications_enabled)}:{is_favorite:false,notifications_enabled:false};return json(favorite);}
      if(p.endsWith("/notifications/preview"))return json({eligible_recipients:favorite.notifications_enabled?1:0,can_send_now:favorite.notifications_enabled,next_available_at:null});
      if(p.endsWith("/notifications/campaigns")){if(req.method==="POST"){const campaign={id:randomUUID(),kind:"marketing",status:"queued",title:body.title,body:body.body,recipient_count:favorite.notifications_enabled?1:0,sent_count:0,failed_count:0,created_at:new Date().toISOString(),completed_at:null};campaigns.unshift(campaign);return json(campaign,201);}return json(campaigns);}
      if(p.includes("/public/"))return published.length?json({restaurant,site,sections:published,version:2,published_at:new Date().toISOString()}):json({detail:"Меню не опубликовано"},404);
      if(p.endsWith("/menu/ai/status"))return json({provider:"gigachat",configured:true,capabilities:["create_item","variants","modifier_groups"]});
      if(p.endsWith("/menu/ai/plan")){
        if(body.expected_revision!==rev(revision))return json({detail:"Меню изменилось"},409);
        aiProposal={proposal_id:randomUUID(),expires_at:new Date(Date.now()+600000).toISOString(),plan:{summary:"Добавить капучино с размерами и молоком",warnings:[],operations:[{type:"create_item",section_name:"Кофе",create_section_if_missing:true,item:{name:"Капучино с ИИ",description:"Эспрессо и молоко",base_price_minor:19000,weight_text:null,variants:[{name:"300 мл",price_minor:19000,weight_text:"300 мл",is_available:true,is_default:true},{name:"400 мл",price_minor:23000,weight_text:"400 мл",is_available:true,is_default:false}],modifier_groups:[{name:"Молоко",min_quantity:1,max_quantity:1,options:[{name:"Обычное",price_minor:0,min_quantity:0,max_quantity:1,default_quantity:1,is_available:true},{name:"Овсяное",price_minor:5000,min_quantity:0,max_quantity:1,default_quantity:0,is_available:true}]}]}}]}};
        return json(aiProposal);
      }
      if(p.endsWith("/menu/ai/apply")){
        if(!aiProposal||body.proposal_id!==aiProposal.proposal_id)return json({detail:"Предложение не найдено"},404);
        const generated=item("Капучино с ИИ",19000,null); generated.description="Эспрессо и молоко"; generated.configuration={variants:[{id:randomUUID(),name:"300 мл",price_minor:19000,weight_text:"300 мл",is_available:true},{id:randomUUID(),name:"400 мл",price_minor:23000,weight_text:"400 мл",is_available:true}],default_variant_id:null,modifier_groups:[{id:randomUUID(),name:"Молоко",min_quantity:1,max_quantity:1,options:[option("Обычное",0,1),option("Овсяное",5000)]}]}; generated.configuration.default_variant_id=generated.configuration.variants[0].id; sections[0].items.push(generated); revision++; aiProposal=null;
        return json({menu_id:restaurant.menu_id,draft_version_id:restaurant.draft_version_id,revision:rev(revision),sections});
      }
      if(p.endsWith("/menu/draft")){if(req.method==="PUT"){if(body.expected_revision!==rev(revision))return json({detail:"Меню изменилось в другой вкладке. Сохраните копию и обновите черновик."},409);revision++;sections=body.sections.map(s=>({...s,id:randomUUID(),items:s.items.map(i=>({...i,id:randomUUID()}))}));}return json({menu_id:restaurant.menu_id,draft_version_id:restaurant.draft_version_id,revision:rev(revision),sections});}
      if(p.endsWith("/menu/publish")){if(body.expected_revision!==rev(revision))return json({detail:"Меню изменилось"},409);published=structuredClone(sections);restaurant.current_published_version_id=randomUUID();campaigns.unshift({id:randomUUID(),kind:"menu_published",status:"completed",title:"Меню опубликовано",body:`«${restaurant.name}»: новая версия меню.`,recipient_count:1,sent_count:1,failed_count:0,created_at:new Date().toISOString(),completed_at:new Date().toISOString()});return json({version:2,item_count:published.reduce((n,s)=>n+s.items.length,0),public_id:restaurant.public_id});}
      if(p.endsWith("/menu/links"))return json({public_menu_url:`http://127.0.0.1:${port}/r/test-point`,max_deep_link:null});
      if(p.endsWith("/menu/qr")){res.writeHead(200,{"Content-Type":"image/png"});return res.end(fs.readFileSync(path.join(__dirname,"fixtures/menu-qr.png")));}
      if(p.endsWith("/site/draft")){if(req.method==="PUT"){if(body.expected_revision!==rev(siteRevision))return json({detail:"Оформление изменилось"},409);const {expected_revision,...next}=body;site=next;siteRevision++;}return json({restaurant_id:restaurant.id,config:site,revision:rev(siteRevision),published_version:0,published_at:null});}
      if(p.endsWith("/site/publish"))return json({published_version:1,published_at:new Date().toISOString()});
      if(p.endsWith("/imports"))return json([]);
      return json({detail:"Недоступно в визуальной фикстуре"},404);
    }
    const requested=path.resolve(root,"."+decodeURIComponent(p));if(!requested.startsWith(root+path.sep)&&requested!==root){res.writeHead(403);return res.end();}
    const file=fs.existsSync(requested)&&fs.statSync(requested).isFile()?requested:path.join(root,"index.html");
    const types={".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",".png":"image/png"};res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});res.end(fs.readFileSync(file));
  }catch(error){res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({detail:error.message}));}
});
server.listen(port,"127.0.0.1",()=>console.log(`Visual fixture only: http://127.0.0.1:${port}; changes live in memory, no database or payments.`));
