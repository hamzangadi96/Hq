
(() => {
  if (window.CBXConfiguratorBoot) return;
  window.CBXConfiguratorBoot = true;
  function mount(root) {
  if (root.dataset.initialized) return;
  root.dataset.initialized='true';
  const dialog=root.closest('dialog');
  const config=JSON.parse(root.querySelector('[data-cbx-data]').textContent);
  const Core=window.CBXConfiguratorCore;
  const cartAPI=new window.CBXConfiguratorCart(window.Shopify?.routes?.root || config.rootUrl);
  const A=config.assets;
  let overrides={};try{overrides=JSON.parse(config.profileOverrides);}catch{}
  let closeOnPersonalEntry=false,animateRibbonPreview=false;
  let busy=false,cartSnapshot=null,lastTrigger=null,inspection=null;
  const newId=()=>window.crypto?.randomUUID?.() || 'cbx-'+Date.now()+'-'+Math.random().toString(36).slice(2);

  const colors=config.colors;
  const flavors=Core.normalize(config.flavors,overrides);
  flavors.forEach(f=>{A['taste-'+f.id]=f.image;});
  // Use the same front views and swirl colours as the homepage display.
  const frontViews={"pistache-rode-vruchten":["cb-niche-pistache-front-v2.png",1254,1254,76,201,1184,1087],"matcha-aardbei":["cb-niche-matcha-aardbei-front-v1.png",1254,1254,74,200,1185,1087],"gezouten-karamel":["cb-niche-gezouten-karamel-front-soft-edge-v1.png",1254,1254,72,199,1184,1088],"stroopwafel":["cb-niche-stroopwafel-front-soft-edge-v1.png",1254,1254,73,199,1187,1088],"vanille-blauwe-bes":["cb-niche-vanille-blauwe-bes-front-v1.png",1254,1254,75,201,1185,1087]};
  const nicheLooks={
   'biscoff-karamel':['milk',[.77,.48,.29],false],
   'cappuccino-hazelnoot':['milk',[.90,.22,.055],false],
   'kersen-bastogne':['dark',[.86,.025,.025],false],
   'kokos-ananas':['dark',[1,.72,.035],false],
   'matcha-blauwe-bes':['white',[.57,.23,.09],true],
   'pinda-karamel':['milk',[.88,.64,.16],false],
   'pistache-kadayif':['milk',[.67,.76,.36],false],
   'vanille-hazelnoot':['white',[.57,.23,.09],true]
  };
  const filterHost=document.createElement('div');filterHost.setAttribute('aria-hidden','true');filterHost.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  filterHost.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs>'+Object.entries(nicheLooks).map(([id,[body,tone,red]])=>{
   const mask=red?'0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4 -4 0 0 -.72':'0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -3 1.5 1.5 0 -.4';
   const stripe=tone.map(v=>red?[v,1-v,0,0,0].join(' '):[1-v,0,v,0,0].join(' ')).join(' ')+' 0 0 0 1 0';
   const shell=body==='dark'?'<feComponentTransfer in="SourceGraphic" result="shell"><feFuncR type="table" tableValues="0 .13 .26 .5 1"/><feFuncG type="table" tableValues="0 .115 .23 .46 1"/><feFuncB type="table" tableValues="0 .1075 .215 .43 1"/></feComponentTransfer>':'<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="shell"/>';
   const base=red?frontViews['pistache-rode-vruchten']:frontViews['gezouten-karamel'];
   frontViews[id]=[...base];
   return '<filter id="cbx-display-tint-'+id+'" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix in="SourceGraphic" type="matrix" values="'+mask+'" result="rawMask"/><feComponentTransfer in="rawMask" result="mask"><feFuncA type="linear" slope="2.5" intercept="0"/></feComponentTransfer>'+shell+'<feComposite in="shell" in2="mask" operator="out" result="body"/><feComponentTransfer in="SourceGraphic" result="stripeLight"><feFunc'+(red?'G':'R')+' type="table" tableValues="0 0 0 .45 1"/></feComponentTransfer><feColorMatrix in="stripeLight" type="matrix" values="'+stripe+'" result="color"/><feComposite in="color" in2="mask" operator="in" result="stripe"/><feMerge><feMergeNode in="body"/><feMergeNode in="stripe"/></feMerge></filter>';
  }).join('')+'</defs></svg>';root.append(filterHost);
  const displayOrder=['matcha-aardbei','gezouten-karamel','pistache-rode-vruchten','biscoff-karamel','kokos-ananas','vanille-blauwe-bes','stroopwafel','vanille-hazelnoot','matcha-blauwe-bes','kersen-bastogne','cappuccino-hazelnoot','pinda-karamel','pistache-kadayif'];
  const displayRank=new Map(displayOrder.map((id,index)=>[id,index]));
  const tasteOptions=['Karamel','Noten','Fruit','Koffie','Matcha'];
  const allergenOptions=[['melk','Melk'],['pinda','Pinda'],['noten','Noten'],['gluten','Glutenbevattende granen'],['soja','Soja'],['ei','Ei'],['sesam','Sesam'],['sulfiet','Sulfiet'],['lupine','Lupine'],['selderij','Selderij'],['mosterd','Mosterd'],['vis','Vis'],['schaaldieren','Schaaldieren'],['weekdieren','Weekdieren']];
  const createBox=(route,number=1)=>({uid:newId(),route,number,name:'',ribbonText:'',occasion:'Zomaar',size:16,color:'lichtblauw',counts:Array(flavors.length).fill(0),allergyMode:'unset',allergens:[],prefs:[],intensity:2,card:false,message:'',ribbon:'Geen lint',step:0,boxPanel:'size',editing:null});
  let route='gift',boxes={gift:createBox('gift'),self:createBox('self'),curated:createBox('curated')},basket=[],cartOpen=false,advisor='',proposal=null,detail=null,feedback='';
  let allergyExpanded=false;
  // Keep the scroll cue truthful when the final flavour comes into view.
  root.addEventListener('change',e=>{if(!e.target.matches('[data-chocolate-select]'))return;chocolateFilter=e.target.value;const list=el('cb-main').querySelector('.cb-tastes');list.outerHTML=flavorList();say('Chocoladefilter: '+chocolateFilter);});
  let mobileScrollTimer=0;
  root.addEventListener('scroll',e=>{
    const panel=e.target;
    if(panel.matches?.('.cb-content'))panel.classList.toggle('cb-flavors-end',panel.scrollTop+panel.clientHeight>=panel.scrollHeight-38);
  },true);
  const settings={previewTone:'Zand',imageSize:100};
  const el=id=>root.querySelector('[data-cb="'+id+'"]') || root.querySelector('#'+id);
  // Header and footer heights vary with the recipient, screen width and feedback.
  const previewObserver=new ResizeObserver(entries=>{
    entries.forEach(({target})=>{
      const height=Math.ceil(target.getBoundingClientRect().height);
      const property=target.classList.contains('cb-header')?'--cb-header-height':target.classList.contains('cb-steps')?'--cb-steps-height':'--cb-footer-height';
      if(height&&root.style.getPropertyValue(property)!==height+'px')root.style.setProperty(property,height+'px');
    });
  });
  previewObserver.observe(root.querySelector('.cb-header'));
  previewObserver.observe(el('cb-steps'));
  previewObserver.observe(el('cb-footer'));
  root.cbxDisconnectPreview=()=>previewObserver.disconnect();
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const box=()=>boxes[route];
  const sum=arr=>arr.reduce((a,b)=>a+b,0);
  const total=()=>sum(box().counts);
  const cash=n=>Number.isFinite(n)?(n/100).toLocaleString('nl-NL',{style:'currency',currency:config.currency}):'Niet beschikbaar';
  const toCore=b=>({...b,counts:Object.fromEntries(flavors.map((f,i)=>[f.id,b.counts[i]||0]))});
  const cost=b=>Core.totalPrice(toCore(b),config);
  const colorName=b=>colors.find(c=>c[0]===b.color)[1];
  const boxName=b=>b.route==='self'?'Voor mezelf':b.name.trim()?'Voor '+b.name.trim():'Cadeau '+b.number;
  const who=()=>box().name.trim()||'de ontvanger';
  const giftName=()=>route==='gift'?esc(box().name.trim()):'';
  const allergyText=b=>b.allergyMode==='none'?'Geen allergieën bekend':b.allergyMode==='unknown'?'Allergenen onbekend':b.allergens.length?b.allergens.map(a=>allergenOptions.find(x=>x[0]===a)?.[1]||a).join(', '):'Niet opgegeven';
  const blocked=()=>box().allergyMode==='select'&&(route==='curated'||!config.allergensVerified||!box().allergens.length);
  const available=i=>Core.eligible(flavors[i],toCore(box()),config)&&(flavors[i].stock===null||box().counts[i]<flavors[i].stock);
  const uitTekst=i=>{const f=flavors[i];return f.stock===0?'Uitverkocht':!f.available?'Niet beschikbaar':(f.stock!==null&&(box().counts[i]||0)>=f.stock)?'Nog '+f.stock+' beschikbaar':'Niet beschikbaar voor deze keuze';};
  const icon=name=>'<span class="cb-icon" aria-hidden="true">'+({'arrow-right':'→','arrow-left':'←','check':'✓','plus':'+','info':'ⓘ','sparkles':'✧','sliders-horizontal':'≡'}[name]||'')+'</span>';
  const photo=(url,alt,cls='')=>(!url&&alt==='Pinda & karamel'&&A.cappuccinoCutout)?'<img class="'+cls+'" src="'+esc(A.cappuccinoCutout)+'" alt="'+esc(alt)+'" style="filter:url(#cb-look-pinda-karamel)" loading="lazy">':url?'<img class="'+cls+'" src="'+esc(url)+'" alt="'+esc(alt)+'" loading="lazy" decoding="async">':'<span class="cb-missing-photo">Foto volgt</span>';
  function displayPhoto(flavor) {
    const artwork=frontViews[flavor.id];
    if(!artwork||!A.cappuccinoCutout)return photo(flavor.image,'');
    const [file,imageWidth,imageHeight,left,,right,bottom]=artwork;
    const width=right-left;
    const url=new URL(file,new URL(A.cappuccinoCutout,document.baseURI));
    const tint=nicheLooks[flavor.id]?'url(#cbx-display-tint-'+flavor.id+')':'none';
    return '<div class="cb-niche__product cb-niche__product--box" style="--niche-photo-width:'+(imageWidth/width*100)+'%;--niche-photo-left:'+(-left/width*100)+'%;--niche-photo-bottom:'+(-(imageHeight-bottom)/width*100)+'%;--niche-flavour-filter:'+tint+'"><img class="cb-niche__photo" src="'+esc(url.href)+'" alt="" width="'+imageWidth+'" height="'+imageHeight+'" loading="lazy" decoding="async"></div>';
  }

  const say=t=>{el('cb-announcement').textContent=t;};
  const radioChip=(group,value,label,checked)=>'<label class="cb-chip"><input type="radio" name="'+group+'" value="'+value+'" '+(checked?'checked':'')+'>'+label+'</label>';
  function steps(){return route==='self'?['Je doos','Bonbons','Overzicht']:['Je doos',route==='curated'?'Onze selectie':'Bonbons','Persoonlijk','Overzicht'];}
  function updateRecipientHeader(){
    const b=box(),label=el('cb-recipient-label'),button=root.querySelector('[data-action="edit-recipient"]');
    label.innerHTML=b.name.trim()?'<span class="cb-for-prefix">Voor </span><span class="cb-header-name">'+esc(b.name.trim())+'</span>':'Voor wie?';
    button.setAttribute('aria-label',b.name.trim()?'Ontvanger wijzigen: '+b.name.trim():'Naam ontvanger invullen');button.title=b.name.trim()?'Voor '+b.name.trim():'Voor wie?';
  }
  function renderSteps(){
    el('cb-steps').innerHTML=(route!=='curated'?'<li><button type="button" class="cb-step" data-action="purpose" '+(['purpose','recipient'].includes(box().boxPanel)&&box().step===0?'aria-current="step"':'')+'><span class="cb-step-number">1</span>Voor wie</button></li>':'')+steps().map((label,i)=>route==='curated'&&i===1?'':'<li><button type="button" class="cb-step" data-step="'+i+'" '+(i===box().step&&!['purpose','recipient'].includes(box().boxPanel)?'aria-current="step"':'')+'><span class="cb-step-number">'+(route==='curated'?(i>1?i:i+1):i+2)+'</span>'+label+'</button></li>').join('');
  }
  // Keep selection order independent of the flavor catalog.
  function packingOrder(b){
    const remaining=[...b.counts],order=[];
    for(const id of b.packingOrder||[]){
      const i=flavors.findIndex(f=>f.id===id);
      if(i>=0&&remaining[i]>0){order.push(id);remaining[i]--;}
    }
    remaining.forEach((n,i)=>{for(let k=0;k<n;k++)order.push(flavors[i].id);});
    b.packingOrder=order;
    return order;
  }
  function packingSlot(index,size){
    const side=Math.sqrt(size),column=Math.floor(index/side),offset=index%side;
    return (column%2?side-1-offset:offset)*side+column;
  }
  function trayPieces(){
    const b=box(),ordered=packingOrder(b).map(id=>({i:flavors.findIndex(f=>f.id===id),proposed:false}));
    if(proposal)proposal.forEach((n,i)=>{for(let k=0;k<n;k++)ordered.push({i,proposed:true});});
    const pieces=[];
    ordered.forEach((piece,index)=>{pieces[packingSlot(index,b.size)]=piece;});
    return pieces;
  }
  const flavorLooks={
    'kersen-bastogne':['dark','red'],
    'kokos-ananas':['dark','yellow'],
    'matcha-aardbei':['white','green'],
    'matcha-blauwe-bes':['white','brown'],
    'pinda-karamel':['milk','gold'],
    'pistache-kadayif':['milk','pistachio'],
    'pistache-rode-vruchten':['white','red'],
    'stroopwafel':['milk','amber'],
    'vanille-blauwe-bes':['white','slate'],
    'vanille-hazelnoot':['white','brown']
  };
  const bodyMatrices={
    milk:'1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0',
    dark:'.52 0 0 0 0 0 .46 0 0 0 0 0 .43 0 0 0 0 0 1 0',
    white:'.085 .285 .03 0 .73 .081 .271 .028 0 .70 .072 .242 .026 0 .60 0 0 0 1 0'
  };
  const swirlTones={red:[.94,.10,.08],yellow:[1,.72,.035],green:[.38,.53,.19],brown:[.57,.23,.09],gold:[.88,.64,.16],pistachio:[.67,.76,.36],amber:[1,.52,.06],slate:[.43,.56,.65]};
  const swirlMatrix=t=>t.map(v=>v+' 0 0 0 .018').join(' ')+' 0 0 0 1 0';
  if(!document.getElementById('cb-extra-flavor-filters')){
    const host=document.createElement('div');host.id='cb-extra-flavor-filters';host.setAttribute('aria-hidden','true');
    host.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    host.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs>'+Object.entries(flavorLooks).map(([id,[body,tone]])=>
      '<filter id="cb-look-'+id+'" color-interpolation-filters="sRGB" primitiveUnits="objectBoundingBox"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4 -4 0 0 -0.72" result="rawMask"/><feComponentTransfer in="rawMask" result="solidMask"><feFuncA type="linear" slope="6" intercept="-.03"/></feComponentTransfer><feMorphology in="solidMask" operator="dilate" radius=".008" result="closedMask"/><feMorphology in="closedMask" operator="erode" radius=".008" result="mask"/>'+ 
      '<feColorMatrix in="SourceGraphic" type="matrix" values="'+bodyMatrices[body==='white'&&A.pistacheRedCutout?'milk':body]+'" result="body"/><feComposite in="body" in2="SourceAlpha" operator="in" result="shell"/>'+ 
      '<feColorMatrix in="SourceGraphic" type="matrix" values="'+swirlMatrix(swirlTones[tone])+'" result="color"/><feComposite in="color" in2="mask" operator="in" result="stripe"/><feMerge><feMergeNode in="shell"/><feMergeNode in="stripe"/></feMerge></filter>'
    ).join('')+'</defs></svg>';root.append(host);
  }
  const isCappuccino=i=>['cappuccino-hazelnoot','biscoff-karamel','gezouten-karamel'].includes(flavors[i]?.id)||Object.hasOwn(flavorLooks,flavors[i]?.id);
  // Reuse the exact approved pixels; recolor only the saturated red swirl at render time.
  if(!document.getElementById('cb-biscoff-swirl')){
    const filterHost=document.createElement('div');
    filterHost.setAttribute('aria-hidden','true');
    filterHost.style.cssText='position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    filterHost.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs><filter id="cb-biscoff-swirl" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4 -4 0 0 -0.72" result="redMask"/><feComposite in="redMask" in2="SourceAlpha" operator="in" result="mask"/><feColorMatrix in="SourceGraphic" type="matrix" values=".88 0 0 0 .18 0 .82 0 0 .16 0 0 .82 0 .13 0 0 0 1 0" result="lighter"/><feComposite in="lighter" in2="mask" operator="in" result="swirl"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="swirl"/></feMerge></filter><filter id="cb-salted-swirl" color-interpolation-filters="sRGB"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4 -4 0 0 -0.72" result="redMask"/><feComposite in="redMask" in2="SourceAlpha" operator="in" result="mask"/><feColorMatrix in="SourceGraphic" type="matrix" values=".18 0 0 0 .05 .62 .15 0 0 .10 .82 .12 0 0 .10 0 0 0 1 0" result="lighter"/><feComposite in="lighter" in2="mask" operator="in" result="swirl"/><feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="swirl"/></feMerge></filter></defs></svg>';
    root.append(filterHost);
  }
  const slotContent=piece=>{
    if(!piece)return '';
    const f=flavors[piece.i],custom=isCappuccino(piece.i)&&A.cappuccinoCutout;
    const approvedPistache=f.id==='pistache-rode-vruchten'&&A.pistacheRedCutout;
    const approvedWhite=flavorLooks[f.id]?.[0]==='white'&&A.pistacheRedCutout;
    const approvedKokos=f.id==='kokos-ananas'&&A.kokosAnanasCutout;
    const approvedKersen=f.id==='kersen-bastogne'&&A.kersenBastogneCutout;
    const src=approvedKersen||approvedKokos||approvedWhite||approvedPistache||custom||f.image;
    return src?'<img '+(custom?'class="cb-cappuccino-cutout'+(f.id==='biscoff-karamel'?' cb-biscoff-cutout':f.id==='gezouten-karamel'?' cb-salted-cutout':'')+'" ':'')+(custom&&!approvedPistache&&!approvedKokos&&!approvedKersen&&flavorLooks[f.id]?'style="filter:url(#cb-look-'+f.id+') drop-shadow(0 2px 1px #0005)" ':'')+'src="'+esc(src)+'" alt="">':'<span class="cb-slot-placeholder" aria-hidden="true">'+esc(f.name.charAt(0))+'</span>';
  };
  function selectedTraySlots(){
    const pieces=trayPieces();
    return Array.from({length:box().size},(_,j)=>'<div class="cb-slot '+(pieces[j]?.proposed?'cb-proposed':'')+'" data-flavor="'+(pieces[j]?.i??'')+'">'+slotContent(pieces[j])+'</div>').join('');
  }
  let box3DModule,box3DFrame;
  function enhanceBox3D(){
    if(!A.box3dModule)return;
    // Finish the DOM update before synchronizing visible 3D views.
    cancelAnimationFrame(box3DFrame);
    box3DFrame=requestAnimationFrame(()=>{
      if(!box3DModule)box3DModule=import(A.box3dModule).catch(error=>{box3DModule=null;throw error});
      box3DModule.then(module=>module.enhance(root,A)).catch(()=>{});
    });
  }
  // Reuse the same assets, packing order and 3D engine in the cart.
  root.cbxRenderCartPreview=async(host,data)=>{
    const b=fromStored(data);
    if(b.route==='curated'||totalForCart(b)!==b.size)return false;
    const order=packingOrder(b),pieces=[];
    order.forEach((id,index)=>{const i=flavors.findIndex(f=>f.id===id);if(i>=0)pieces[packingSlot(index,b.size)]={i}});
    const tray=document.createElement('div');tray.className='cb-tray cb-model-tray';
    tray.dataset.boxSize=String(b.size);tray.dataset.boxColor=colors.find(c=>c[0]===b.color)[2];
    tray.style.setProperty('--cart-box-color',tray.dataset.boxColor);tray.style.setProperty('--cart-box-columns',Math.sqrt(b.size));
    tray.setAttribute('role','img');tray.setAttribute('aria-label',b.size+' gekozen bonbons in een '+colorName(b)+' doos');
    tray.innerHTML=Array.from({length:b.size},(_,i)=>'<div class="cb-slot">'+slotContent(pieces[i])+'</div>').join('');
    host.replaceChildren(tray);host.hidden=false;
    const images=[...tray.querySelectorAll('img')];
    for(const img of images){img.loading='eager';img.decoding='sync';img.fetchPriority='high'}
    await Promise.all(images.map(img=>img.decode()));
    try{
      if(!box3DModule)box3DModule=import(A.box3dModule).catch(e=>{box3DModule=null;throw e});
      const module=await box3DModule;
      await module.enhance(host,A);
      if(tray.cbxSnapshot){
        const snapshot=tray.cbxSnapshot(),width=tray.getBoundingClientRect().width;
        const still=tray.cloneNode(true),canvas=still.querySelector('canvas');
        if(canvas){const image=document.createElement('img');image.className='cbx-cart-box-surface';image.src=snapshot;image.alt='';image.style.cssText='display:block;width:100%;height:100%;position:absolute;inset:0';await image.decode();canvas.replaceWith(image)}
        still.querySelectorAll('.cb-slot').forEach(slot=>{for(const property of ['--cb-seat-size','--cb-cup-size']){const value=slot.style.getPropertyValue(property);if(value.endsWith('px'))slot.style.setProperty(property,parseFloat(value)/width*100+'%')}});
        still.querySelectorAll('span').forEach(el=>{if(el.style.background.includes('radial-gradient')){for(const property of ['width','height']){const value=el.style[property];if(value.endsWith('px'))el.style[property]=parseFloat(value)/width*100+'%'}}});
        await module.release(host);
        host.replaceChildren(still);
        host.dataset.staticPreview='true';
      }
    }catch{}
    host.parentElement.querySelector(':scope > img')?.setAttribute('hidden','');
    return true;
  };
  function totalForCart(b){return b.counts.reduce((n,v)=>n+v,0)}
  document.dispatchEvent(new CustomEvent('cbx:cart-preview-ready'));
  function fitGiftCard(){
    const card=root.querySelector('.cb-gift-paper'),message=card?.querySelector('p');
    if(!card||!message||!card.clientWidth)return;
    const style=getComputedStyle(card),logo=card.querySelector('img');
    const available=card.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    message.style.flex='0 0 auto';message.style.textWrap='pretty';
    let size=14;
    message.style.fontSize=size+'px';message.style.lineHeight='1.35';
    while((message.scrollHeight>available||message.scrollWidth>message.clientWidth)&&size>2){
      size-=.25;message.style.fontSize=size+'px';
    }
  }
  const cardResize=new ResizeObserver(()=>fitGiftCard());
  function observeGiftCard(){cardResize.disconnect();const card=root.querySelector('.cb-gift-paper');if(card){cardResize.observe(card);card.querySelector('img')?.addEventListener('load',fitGiftCard,{once:true});fitGiftCard();}}
  function renderPreview(){
    const b=box(),isPersonal=route!=='self'&&b.step===2;
    if(isPersonal&&route==='gift'){
      // Keep decoded product images and layout nodes mounted while typing.
      const scene=root.querySelector('.cb-gift-scene');
      const message=scene?.querySelector('.cb-gift-paper p');
      const ribbons=scene?.querySelectorAll('.cb-ribbon-label');
      if(message){message.textContent=b.message||'Jouw persoonlijke boodschap.';fitGiftCard();}
      ribbons?.forEach(ribbon=>ribbon.textContent=b.ribbonText||'Jouw tekst op het lint');const tray=scene?.querySelector('.cb-personal-box');if(tray&&b.ribbon!=='Geen lint'){tray.dataset.ribbonText=b.ribbonText||'Voor jou';}
      return;
    }
    const showTray=route!=='curated'&&b.step===1;
    let stage='';
    if(isPersonal&&b.card){
      stage='<div class="cb-stage cb-personal-stage"><img class="cb-mini-box" src="'+A['box-'+b.color]+'" alt="'+colorName(b)+' doos"><div class="cb-card-preview"><p>'+esc(b.message||'Jouw persoonlijke boodschap.')+'</p><img src="'+A.logo+'" alt="Cacaoboetiek"></div></div>';
    }else if(showTray){
      const pieces=trayPieces();
      stage='<div class="cb-stage"><div class="cb-tray cb-model-tray" data-box-size="'+b.size+'" data-box-color-name="'+b.color+'" data-box-color="'+colors.find(c=>c[0]===b.color)[2]+'" style="--tray-color:'+colors.find(c=>c[0]===b.color)[2]+';grid-template-columns:repeat('+(b.size===16?4:5)+',1fr);max-width:'+(b.size===16?280:320)+'px" role="img" aria-label="'+pieces.filter(Boolean).length+' van '+b.size+' plekken gevuld">'+Array.from({length:b.size},(_,j)=>'<div class="cb-slot '+(pieces[j]?.proposed?'cb-proposed':'')+'" data-flavor="'+(pieces[j]?.i??'')+'">'+slotContent(pieces[j])+'</div>').join('')+'</div></div>';
    }else{
      stage='<div class="cb-stage"><div class="cb-tray cb-model-tray" data-lid-closed="true" data-ribbon-instant="true" '+(b.ribbon!=='Geen lint'?'data-ribbon-text="'+esc(b.ribbonText||'Voor jou')+'" ':'')+'data-box-size="'+b.size+'" data-box-color-name="'+b.color+'" data-box-color="'+colors.find(c=>c[0]===b.color)[2]+'" role="img" aria-label="'+b.size+' bonbons in '+esc(colorName(b))+' doos">'+selectedTraySlots()+'</div></div>';
    }
    el('cb-preview').innerHTML='<div class="cb-recipient" data-recipient>'+esc(boxName(b))+'</div>'+stage+'<div class="cb-box-caption"><h2>'+(b.size===16?'Klein gebaar':'Groots genieten')+'</h2><p>'+b.size+' bonbons · '+colorName(b)+(isPersonal&&b.ribbon!=='Geen lint'?' · '+esc(b.ribbon)+' lint':'')+'</p>'+(showTray?'<div class="cb-progress"><span style="width:'+Math.min(100,(total()+(proposal?sum(proposal):0))/b.size*100)+'%"></span></div><p>'+(proposal?'Met jouw selectie: ':'')+'<strong data-chosen-count>'+ (total()+(proposal?sum(proposal):0))+' van '+b.size+'</strong> gekozen</p>':'')+'</div>';
    if(root.classList.contains('cb-bonbonbar')){
      const tray=el('cb-preview').querySelector('.cb-tray'),zoom=document.createElement('button');
      zoom.type='button';zoom.className='cb-tray-open';zoom.dataset.action='inspect-box';
      zoom.setAttribute('aria-label','Bekijk je gekozen bonbons groter');
      tray.before(zoom);zoom.append(tray);
      zoom.insertAdjacentHTML('afterend','<button type="button" class="cb-text-button cb-lid-toggle" data-action="toggle-lid" aria-pressed="false" style="display:block;margin:8px auto 14px">Deksel erop</button>');
      el('cb-preview').insertAdjacentHTML('beforeend','<div class="cb-box-status"><strong data-box-status></strong><p data-box-status-note></p></div><button type="button" class="cb-bar-advice cb-advice-entry" data-action="advisor">'+icon('sparkles')+' Help mij kiezen</button>');
      if(advisor)el('cb-preview').insertAdjacentHTML('beforeend','<div class="cb-advisor-bar-title">'+intro(giftName()?'Wat vindt '+giftName()+' lekker?':'Wat vind je lekker?','Kies je smaken en tik om toe te voegen')+'</div>');
      updateBoxStatus();
    }
    enhanceBox3D();
    el('cb-preview').style.background=root.classList.contains('cb-bonbonbar')?'#ffffff':settings.previewTone==='Wit'?'#fffefb':'#f5f0e9';
  }
  function intro(title,subtitle){return '<div class="cb-intro"><h1 tabindex="-1">'+title+'</h1><p>'+subtitle+'</p></div>';}
  function choiceBox3D(size,color,small=false){
    const tone=colors.find(c=>c[0]===color)?.[2]||'#4c2f23';
    return '<span class="cb-choice-stage'+(small?' cb-choice-stage-small':'')+'" aria-hidden="true"><span class="cb-tray cb-model-tray cb-choice-box" data-box-size="'+size+'" data-box-color="'+tone+'" data-box-color-name="'+esc(color)+'" data-lid-closed="true">'+photo(A['box-'+color],'','cb-choice-fallback')+'</span></span>';
  }
  root.addEventListener('focusout',e=>{if(e.target.id==='cb-name'){root.classList.toggle('cb-recipient-named',Boolean(box().name.trim()));root.classList.remove('cb-recipient-open');}});
  function recipientField(b){return '<div class="cb-field cb-gift-invitation"><label class="cb-label" for="cb-name">Naam van de ontvanger</label><input class="cb-input" id="cb-name" name="recipient" maxlength="40" placeholder="Bijv. Hamza" value="'+esc(b.name)+'" autocomplete="off"></div>';}
  function renderDoos(){
    const b=box(),recipient=giftName();
    if(b.boxPanel==='purpose'&&route!=='curated'){
      const bonbon='<svg class="cb-purpose-original-bonbon" fill="none" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path stroke="currentColor" stroke-width="3.3" stroke-linejoin="round" d="M8.5 46.5C8.5 36.4 14.2 21.8 25.5 12.8C31.4 8.1 38.5 7.6 43.9 10.8C49.8 14.2 49.5 21.4 53.1 28.4C56.1 34.2 60.3 39.5 58.7 46.4C57.4 51.9 47.8 56.3 33.4 56.8C21.8 57.1 8.5 52.6 8.5 46.5Z"/></svg>';
      const gift='<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M12 29h40v22H12ZM10 23h44v6H10ZM29 23v28h6V23M32 23c-2-12-17-14-17-7 0 6 12 7 17 7Zm0 0c2-12 17-14 17-7 0 6-12 7-17 7Z"/></svg>';
      return '<div class="cb-guided-body cb-purpose-screen">'+intro('Voor jezelf of om te geven?','')+'<div class="cb-purpose-choice"><button type="button" data-route="self">'+bonbon+'<strong>Voor mezelf</strong><span>Mijn favoriete bonbons</span></button><button type="button" data-route="gift">'+'<span class="cb-purpose-gift-vector" style="--cb-purpose-mask:url('+esc(A.giftBonbonIcon)+')" aria-hidden="true"></span>'+'<strong>Als cadeau</strong><span>Met aandacht gegeven</span></button></div></div>';
    }
    if(b.boxPanel==='recipient'&&route==='gift')return '<div class="cb-guided-body cb-purpose-screen cb-recipient-screen">'+intro('Voor wie is het cadeau?','')+'<form class="cb-recipient-form" data-recipient-form>'+recipientField(b)+'<div class="cb-recipient-actions"><button type="button" class="cb-secondary" data-action="skip-recipient">Doorgaan zonder naam</button><button type="submit" class="cb-primary">Kies je formaat '+icon('arrow-right')+'</button></div><button type="button" class="cb-text-button cb-recipient-back" data-action="purpose">Terug</button></form></div>';
    if(b.boxPanel==='color')return '<div class="cb-guided-body"><div class="cb-intro"><h1 tabindex="-1">'+(recipient?'Kies de kleur voor '+recipient:'Kies je kleur')+'</h1><div class="cb-choice-context"><span data-choice-summary>'+b.size+' bonbons · '+colorName(b)+'</span><span aria-hidden="true">·</span><button type="button" class="cb-guided-back" data-action="box-size">Formaat wijzigen</button></div></div>'+
      '<div class="cb-color-cards" role="group" aria-label="Kies de kleur van je doos">'+colors.map(c=>'<button type="button" class="cb-color-card" data-color="'+c[0]+'" aria-pressed="'+(b.color===c[0])+'"><span class="cb-color-photo">'+choiceBox3D(b.size,c[0])+'</span><span class="cb-color-label"><span>'+c[1]+'</span><em aria-hidden="true">'+(b.color===c[0]?'✓':'')+'</em></span></button>').join('')+'</div></div>';
    return '<div class="cb-guided-body">'+intro('Kies je formaat',route==='curated'?esc(b.occasion)+' · '+colorName(b)+' · Door ons samengesteld':route==='gift'?'Hoeveel bonbons wil je '+(recipient?recipient+' ':'')+'geven?':'Hoeveel bonbons mogen er in jouw doos?')+(route==='curated'?'<button type="button" class="cb-text-button" data-action="change-occasion">Andere gelegenheid kiezen</button>':'')+
      (route==='curated'?recipientField(b):'')+
      '<div class="cb-size-options cb-size-cards" role="group" aria-label="Kies het formaat van je doos">'+(matchMedia('(max-width:720px)').matches?[25,16]:[16,25]).map(n=>'<button type="button" class="cb-size" data-size="'+n+'" aria-pressed="'+(b.size===n)+'" '+(n<total()||!config.products[String(n)]?.available?'disabled':'')+'>'+choiceBox3D(n,b.color,n===16)+'<span class="cb-size-caption"><strong>'+n+' bonbons</strong><span class="cb-size-price">'+cash(cost({...b,size:n}))+'</span><em aria-hidden="true">'+(b.size===n?'✓':'')+'</em></span>'+(!config.products[String(n)]?.available?'<span class="cb-size-stock">Tijdelijk niet beschikbaar</span>':'')+'</button>').join('')+'</div>'+(total()>16?'<p class="cb-hint">Voor de kleine doos: verwijder eerst bonbons tot er maximaal 16 over zijn.</p>':'')+'</div>';
  }
  function positionAllergy(){
    const details=root.querySelector('.cb-allergy-direct[open]');if(!details)return;
    const panel=details._allergyPanel||details.querySelector('.cb-allergy-body'),anchor=details.querySelector('summary').getBoundingClientRect();
    if(!panel)return;details._allergyPanel=panel;panel.classList.add('cb-allergy-portal');if(panel.parentElement!==root)root.append(panel);
    const footer=el('cb-footer').getBoundingClientRect(),bar=el('cb-preview').getBoundingClientRect();
    const mobile=window.innerWidth<=700,width=Math.min(mobile?window.innerWidth-24:380,window.innerWidth-24);
    panel.style.width=width+'px';panel.style.left=Math.max(12,Math.min(anchor.right-width,window.innerWidth-width-12))+'px';
    if(mobile){
      panel.style.maxHeight=Math.max(150,Math.min(420,footer.top-root.querySelector('.cb-header').getBoundingClientRect().bottom-24))+'px';
      panel.style.top=Math.max(12,footer.top-panel.getBoundingClientRect().height-8)+'px';
    }else{
      const top=Math.max(bar.bottom+8,Math.min(anchor.bottom+8,footer.top-230));
      panel.style.maxHeight=Math.max(160,footer.top-top-8)+'px';panel.style.top=top+'px';
    }
  }
  root.addEventListener('toggle',e=>{if(e.target.matches?.('.cb-allergy-direct')&&e.target.isConnected){allergyExpanded=e.target.open;if(!e.target.open&&e.target._allergyPanel){e.target.append(e.target._allergyPanel);e.target._allergyPanel.classList.remove('cb-allergy-portal');}positionAllergy();}},true);
  root.addEventListener('keydown',e=>{const expanded=root.querySelector('.cb-allergy-direct[open]');if(e.key==='Escape'&&expanded){e.preventDefault();e.stopPropagation();allergyExpanded=false;expanded.open=false;expanded.querySelector('summary').focus({preventScroll:true});}});
  root.addEventListener('click',e=>{const expanded=root.querySelector('.cb-allergy-direct[open]');if(expanded&&!expanded.contains(e.target)){allergyExpanded=false;expanded.open=false;}});
  const allergyResize=new ResizeObserver(()=>positionAllergy());allergyResize.observe(root);
  const previousDisconnect=root.cbxDisconnectPreview;root.cbxDisconnectPreview=()=>{previousDisconnect();allergyResize.disconnect();};
  function relevantAllergens(){
    const registered=[...flavors.flatMap(f=>[...f.allergens,...f.traces]),...Core.list(config.crossContact)];
    // Keep existing saved declarations editable; never silently discard an allergy.
    return allergenOptions.filter(([key])=>Core.hasAllergen(registered,[key])||box().allergens.includes(key));
  }
  function allergies(){
    const b=box(),selected=b.allergens.length,options=relevantAllergens();
    return '<details class="cb-allergy cb-allergy-direct" '+(allergyExpanded?'open':'')+'><summary>'+icon('sliders-horizontal')+'<span>'+(selected?'Allergenen · '+selected+' gekozen':'Allergenen doorgeven')+'</span></summary><div class="cb-allergy-body" role="region" aria-label="Allergenen doorgeven"><div class="cb-allergy-top"><strong>Welke allergenen wil je doorgeven?</strong><span>Optioneel</span></div><p class="cb-hint">Meerdere keuzes mogelijk.</p><fieldset class="cb-allergen-options"><legend class="cb-sr">Allergenen doorgeven</legend>'+options.map(([a,label])=>'<label class="cb-chip"><input type="checkbox" name="allergen" value="'+a+'" '+(b.allergens.includes(a)?'checked':'')+'><span>'+esc(a==='gluten'?'Gluten':label)+'</span></label>').join('')+'</fieldset>'+(!options.length?'<p class="cb-hint">De allergeneninformatie is nog niet volledig. Neem contact op voor jouw allergie.</p>':'')+'<p class="cb-allergy-disclaimer">'+esc(config.allergensVerified?'Gebaseerd op geregistreerde ingrediënten en mogelijke sporen.':config.allergenNotice)+'</p><div class="cb-allergy-secondary">'+(b.allergyMode!=='unset'?'<button type="button" class="cb-text-button" data-action="clear-allergies">Keuze wissen</button>':'')+'<button type="button" class="cb-allergy-done" data-action="close-allergies">Verder met bonbons '+icon('arrow-right')+'</button></div></div></details>';
  }
  function tasteFavorites(){
    return (box().favoriteIds||[]).map(id=>flavors.find(f=>f.id===id)).filter(Boolean);
  }
  function favoritesNotice(){
    const saved=tasteFavorites();
    return saved.length?'<div class="cb-saved-tastes"><strong>'+saved.length+' '+(saved.length===1?'smaak bewaard':'smaken bewaard')+'</strong><p>'+saved.map(f=>esc(f.name)).join(' · ')+'</p><small>Je favorieten staan vooraan bij de bonbons. Daar kies je de aantallen.</small></div>':'';
  }
  let chocolateFilter="Alles",catalogScrolled=false;
  function flavorDisplayName(flavor) {
    return flavor.id === 'pistache-kadayif' ? 'Dubai · Pistache & kadayif' : flavor.name;
  }
  function flavorFilling(flavor) {
    return flavor.description ? '<h3>Vulling</h3><p>'+esc(flavor.description)+'</p>' : '';
  }
  function flavorCard(i,large=false){
    const f=flavors[i],raw=config.flavors.find(v=>v.id===f.id)||{},ingredients=f.ingredients||raw.ingredients;
    const ingredientText=Array.isArray(ingredients)?ingredients.join(', '):ingredients;
    const note=({melk:'MELK',puur:'PUUR',wit:'WIT'})[String(f.chocolate).toLowerCase()]||f.chocolate;
    const swatches={'Biscoff & karamel':['#cf986e','#df7437'],'Cappuccino & hazelnoot':['#bf997b','#c76737'],'Gezouten karamel':['#85bcc8','#55bbd0'],'Kersen & bastogne':['#bd615e','#ba3c36'],'Kokos & ananas':['#e4be58','#e8b629'],'Matcha & aardbei':['#c0cfa3','#98ad70'],'Matcha & blauwe bes':['#d6b89c','#ac7049'],'Pinda & karamel':['#cbb268','#b89a35'],'Pistache & kadayif':['#a8b87f','#aab774'],'Pistache & rode vruchten':['#c6bc9e','#a5af7d'],'Stroopwafel':['#d8ac7f','#d58435'],'Vanille & blauwe bes':['#b7c6cc','#6f8795'],'Vanille & hazelnoot':['#dbc7af','#a97550']};
    const swatch=swatches[f.name]||['#e0d2c4','#c5a78c'];
    const chocolateLabel=f.chocolate?'<div class="cb-card-chocolate">'+esc(note)+'</div>':'';
    const name=esc(flavorDisplayName(f));
    const flipButton=large?'<button type="button" class="cb-card-flip-icon" data-flip="'+i+'" aria-label="Kaart omdraaien voor ingrediënten en allergenen" aria-pressed="false">'+icon('info')+'</button>':'';
    const face=large
      ? '<div class="cb-taste-photo">'+photo(f.image,f.name)+'</div><div class="cb-taste-name">'+name+'</div>'+chocolateLabel
      : '<figure class="cb-niche__art"><div class="cb-niche__frame"><div class="cb-niche__opening">'
        +(f.chocolate?'<span class="cb-niche__plaque"><span class="cb-niche__plaque-text">'+esc(note)+'</span></span>':'')
        +displayPhoto(f)+'<div class="cb-niche__shelf" aria-hidden="true"></div>'
        +'<button type="button" class="cb-niche__more" data-detail="'+i+'" aria-label="Bekijk de binnenkant van '+name+'"><span aria-hidden="true">?</span></button>'
        +'</div></div><figcaption class="cb-niche__label">'+name+'</figcaption></figure>';
    return '<article class="cb-taste cb-flip-card '+(large?'cb-card-large ':'cb-swatch-card cb-niche ')+(box().counts[i]?'cb-chosen':'')+'" style="--cb-swatch:'+swatch[0]+';--cb-swirl:'+swatch[1]+'" data-flavor-row="'+i+'">'+flipButton+'<div class="cb-card-turn"><div class="cb-card-front">'+face+'</div><div class="cb-card-back" inert aria-hidden="true"><strong>'+esc(flavorDisplayName(f))+'</strong>'+flavorFilling(f)+(ingredientText?'<h3>Ingrediënten</h3><p>'+esc(ingredientText)+'</p>':'')+'<h3>Allergenen</h3><p>'+esc(f.allergens.join(', ')||'Allergeneninformatie niet vermeld.')+'</p>'+(f.traces.length?'<h3>Mogelijke sporen</h3><p>'+esc(f.traces.join(', '))+'</p>':'')+(!large?'<button type="button" class="cb-text-button cb-back-enlarge" data-detail="'+i+'">Vergroot '+icon('maximize')+'</button>':'')+'<p class="cb-small">'+esc(config.allergenNotice)+'</p></div></div><div class="cb-quantity"><button type="button" data-minus="'+i+'" aria-label="Eén '+esc(f.name)+' verwijderen" '+(!box().counts[i]?'disabled':'')+'>−</button><span class="cb-card-count"><span data-quantity>'+box().counts[i]+'</span></span><button type="button" data-plus="'+i+'" aria-label="Eén '+esc(f.name)+' toevoegen" '+(total()>=box().size||!available(i)?'disabled':'')+'>+</button></div><p class="cb-flavor-unavailable" '+(available(i)?'hidden':'')+'>'+uitTekst(i)+'</p></article>';
  }
  function flavorList(){
    if(!flavors.length)return '<p class="cb-note">De smaken konden niet worden geladen.</p>';
    const favorites=new Set(box().favoriteIds||[]);
    return '<div class="cb-tastes cb-niche-wall cb-picker-gallery">'+flavors.map((f,i)=>({f,i})).sort((a,b)=>Number(favorites.has(b.f.id))-Number(favorites.has(a.f.id))||(displayRank.get(a.f.id)??Infinity)-(displayRank.get(b.f.id)??Infinity)).filter(({f})=>chocolateFilter==='Alles'||String(f.chocolate).toLowerCase()===chocolateFilter.toLowerCase()).map(({i})=>flavorCard(i)).join('')+'</div>';
  }
  function renderFlavors(){
    if(advisor)return renderAdvisor();
    return '<div class="cb-flavor-heading">'+intro(route!=='self'?'Wat vindt '+esc(who())+' lekker?':'Welke smaken kies jij?','')+'<div class="cb-catalog-toolbar">'+allergies()+'<div class="cb-inline-filters" role="group" aria-label="Filter op chocolade">'+['Alles','Melk','Puur','Wit'].map(label=>'<button type="button" data-chocolate-filter="'+label+'" aria-pressed="'+(chocolateFilter===label)+'">'+label+'</button>').join('')+'</div></div></div>'+flavorList()+'<span class="cb-scroll-cue" '+(catalogScrolled?'hidden':'')+'>Meer smaken ↓</span>';
  }
  function updateBoxStatus(){
    const full=total()===box().size,last=box().size-total()===1;
    root.classList.toggle('cb-box-full',root.classList.contains('cb-bonbonbar')&&full);
    const status=root.querySelector('[data-box-status]');
    if(status){status.textContent=full?'✓ Je doos is compleet':last?'Nog één bonbon':'';root.querySelector('[data-box-status-note]').textContent=full?'':'';}
    const advice=root.querySelector('.cb-bar-advice');if(advice)advice.hidden=full;
  }
  function findFlavor(i){
    chocolateFilter='Alles';
    const content=el('cb-main');content.innerHTML=renderFlavors();
    const row=content.querySelector('[data-flavor-row="'+i+'"]');
    row?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'nearest'});
    row?.querySelector('[data-minus]')?.focus({preventScroll:true});
    if(row&&!matchMedia('(prefers-reduced-motion:reduce)').matches)row.animate([{boxShadow:'inset 0 0 0 2px #654735'},{boxShadow:'inset 0 0 0 2px transparent'}],{duration:1100});
  }
  root.addEventListener('scroll',e=>{if(!e.target.matches?.('.cb-content,#cb-main'))return;catalogScrolled=true;root.querySelector('.cb-scroll-cue')?.setAttribute('hidden','');},true);
  root.addEventListener('click',e=>{const slot=e.target.closest('.cb-slot');if(!slot||!slot.closest('[data-cb="cb-preview"]')||slot.dataset.flavor==='')return;e.stopImmediatePropagation();e.preventDefault();findFlavor(Number(slot.dataset.flavor));},true);
  function closeInspection(){if(inspection?.open)inspection.close();}
  function openInspection(kind,index){
    closeInspection();
    const trigger=document.activeElement,main=el('cb-main'),scroll=main.scrollTop;
    const panel=document.createElement('dialog');inspection=panel;
    panel.className='cb-inspect';panel.setAttribute('aria-label',kind==='box'?'Jouw gekozen bonbons':flavors[index].name);
    let content='';
    if(kind==='box'){
      const preview=el('cb-preview').querySelector('.cb-tray').cloneNode(true);preview.removeAttribute('style');preview.classList.remove('cb-3d-ready');preview.querySelector('.cb-box3d-surface')?.remove();
      preview.style.setProperty('--tray-color',colors.find(c=>c[0]===box().color)[2]);preview.style.gridTemplateColumns='repeat('+(box().size===16?4:5)+',1fr)';
      content='<h2>Jouw doos van dichtbij.</h2><p class="cb-inspect-context">'+total()+' van '+box().size+' gekozen · '+esc(colorName(box()))+'</p>'+preview.outerHTML+'<ul class="cb-inspect-list">'+flavors.map((f,i)=>box().counts[i]?'<li><span>'+esc(f.name)+'</span><strong>'+box().counts[i]+'×</strong></li>':'').join('')+'</ul>'+(total()?'':'<p>Je gekozen bonbons verschijnen hier.</p>');
    }else{
      const f=flavors[index],raw=config.flavors.find(v=>v.id===f.id)||{},ingredients=f.ingredients||raw.ingredients;
      const ingredientText=Array.isArray(ingredients)?ingredients.join(', '):ingredients;
      panel.classList.add('cb-flavor-inspect');
      content='<div class="cb-flavor-detail"><div class="cb-detail-image">'+photo(f.image,f.name)+'</div><div class="cb-detail-copy"><p class="cb-detail-type">'+esc(f.chocolate)+'</p><h2>'+esc(flavorDisplayName(f))+'</h2>'+(f.description?'<section>'+flavorFilling(f)+'</section>':'')+(ingredientText?'<section><h3>Ingrediënten</h3><p>'+esc(ingredientText)+'</p></section>':'')+'<section><h3>Allergenen</h3><p>'+esc(f.allergens.join(', ')||'Allergeneninformatie niet vermeld.')+'</p>'+(f.traces.length?'<p class="cb-detail-traces">Mogelijke sporen: '+esc(f.traces.join(', '))+'</p>':'')+'</section><p class="cb-detail-notice">'+esc(config.allergenNotice)+'</p></div></div>';
    }
    panel.innerHTML='<button type="button" class="cb-inspect-close" aria-label="Sluiten en terug naar je bonbons">×</button>'+content;
    panel.querySelector('.cb-inspect-close').addEventListener('click',()=>panel.close());
    panel.addEventListener('click',e=>{if(!e.target.closest('[data-flip],[data-plus],[data-minus]'))e.stopPropagation();if(e.target===panel){const r=panel.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)panel.close();}});
    panel.addEventListener('cancel',e=>{e.preventDefault();e.stopPropagation();panel.close();});
    panel.addEventListener('close',e=>{e.stopPropagation();panel.remove();if(inspection===panel)inspection=null;enhanceBox3D();main.scrollTop=scroll;trigger?.focus?.({preventScroll:true});},{once:true});
    root.append(panel);panel.showModal();if(kind==='box')enhanceBox3D();
  }
  let proposalChoices=[];
  function canAddProposal(i){
    return proposal&&!blocked()&&total()+sum(proposal)<box().size&&available(i)&&(flavors[i].stock===null||box().counts[i]+proposal[i]<flavors[i].stock);
  }
  function proposalTiles(){
    return '<div class="cb-tastes cb-advisor-tiles">'+proposalChoices.map(i=>{
      const f=flavors[i],n=proposal[i];
      return '<article class="cb-taste'+(n?' cb-chosen':'')+'" data-flavor-row="'+i+'"><div class="cb-taste-photo">'+photo(f.image,f.name)+'<button type="button" class="cb-info" data-detail="'+i+'" aria-label="Informatie over '+esc(f.name)+'">'+icon('info')+'</button></div><div class="cb-taste-name">'+esc(f.name)+'</div><div class="cb-quantity"><button type="button" data-minus="'+i+'" aria-label="Eén '+esc(f.name)+' uit selectie verwijderen" '+(!n?'disabled':'')+'>−</button><span data-quantity>'+(n||'Toevoegen')+'</span><button type="button" data-plus="'+i+'" aria-label="Eén '+esc(f.name)+' aan selectie toevoegen" '+(!canAddProposal(i)?'disabled':'')+'>+</button></div></article>';
    }).join('')+'</div>';
  }
  function updateProposalTiles(){
    root.querySelectorAll('.cb-advisor-tiles [data-flavor-row]').forEach(row=>{
      const i=Number(row.dataset.flavorRow),n=proposal[i];
      row.classList.toggle('cb-chosen',n>0);row.querySelector('[data-quantity]').textContent=n||'Toevoegen';
      row.querySelector('[data-minus]').disabled=!n;row.querySelector('[data-plus]').disabled=!canAddProposal(i);
    });
    renderPreview();renderFooter();
    const note=root.querySelector('[data-proposal-note]');if(note)note.textContent=proposalNote();
    say(sum(proposal)+' bonbons geselecteerd. '+(box().size-total()-sum(proposal))+' plekken vrij.');
  }
  function proposalNote(){return total()+sum(proposal)===box().size?'Je voorstel vult de doos. Haal er één weg om de verdeling te veranderen.':'Nog '+(box().size-total()-sum(proposal))+' plekken vrij. Tik op een tegel om toe te voegen.';}
  function renderAdvisor(){
    const b=box();
    return '<div class="cb-advisor-filter-head"><button class="cb-text-button" type="button" data-action="close-advisor" aria-label="Terug naar bonbons">'+icon('arrow-left')+'</button>'+intro(giftName()?'Wat vindt '+giftName()+' lekker?':'Wat vind je lekker?','Kies je smaken en tik om toe te voegen')+'</div>'+
      '<div class="cb-advisor-filterbar"><div class="cb-advisor-options" role="group" aria-label="Filter op smaak">'+tasteOptions.map(t=>'<label class="cb-chip"><input type="checkbox" name="preference" value="'+t+'" '+(b.prefs.includes(t)?'checked':'')+'><span>'+t+'</span></label>').join('')+'</div><button class="cb-text-button" type="button" data-action="surprise">Alle smaken</button></div>'+
      '<div class="cb-advisor-result-count">'+proposalChoices.length+' smaken</div>'+
      (blocked()?'<p class="cb-note">'+esc(config.allergenNotice)+'</p>':proposalChoices.length?proposalTiles():'<p class="cb-note">Geen beschikbare bonbons binnen deze smaken. Kies een andere smaak of bekijk alle smaken.</p>');
  }
  function suggestedMessage(){
    const b=box(),greeting=b.name.trim()?b.name.trim()+',':'Voor jou,';
    const texts={'Zomaar':'gewoon omdat je het verdient.','Verjaardag':'van harte gefeliciteerd! Maak er een heerlijke dag van.','Bedankt':'een klein gebaar om je te bedanken.','Beterschap':'een beetje liefs. Hopelijk voel je je snel beter.','Gefeliciteerd':'dit verdient iets lekkers. Van harte!'};
    return greeting+'\n'+(texts[b.occasion]||({'Feestdagen':'Fijne feestdagen! Geniet van deze bonbons en van elkaar.','Ik hou van jou':'Voor jou, met alle liefde.','Veel geluk':'Veel geluk met deze nieuwe stap!'}[b.occasion])||texts.Zomaar);
  }
  function giftRibbon(b){
    const label=esc(b.ribbonText||'Jouw tekst op het lint');
    const gold=false,red=false;
    const light=gold?'#fae8b4':red?'#ae5966':'#fffefa',mid=gold?'#c6a366':red?'#743642':'#e5e0d6',dark=gold?'#8b6836':red?'#48222b':'#aaa397';
    return '<svg class="cb-gift-silk" viewBox="0 0 1000 1000" aria-label="Kruislings gestrikt lint"><defs><linearGradient id="cb-satin"><stop stop-color="'+dark+'"/><stop offset=".22" stop-color="'+light+'"/><stop offset=".55" stop-color="'+mid+'"/><stop offset=".82" stop-color="'+light+'"/><stop offset="1" stop-color="'+dark+'"/></linearGradient><linearGradient id="cb-satin-cross" x2="0" y2="1"><stop stop-color="'+light+'"/><stop offset=".5" stop-color="'+mid+'"/><stop offset="1" stop-color="'+dark+'"/></linearGradient><linearGradient id="cb-ribbon-foil" x1="0" y1="0" x2=".3" y2="1"><stop stop-color="#a57a3b"/><stop offset=".3" stop-color="#e9cb91"/><stop offset=".46" stop-color="#fff0c6"/><stop offset=".58" stop-color="#b18a4a"/><stop offset="1" stop-color="#dfbb7d"/></linearGradient></defs><g stroke="'+dark+'" stroke-opacity=".3" stroke-width="1.5"><path d="M303 193L350 193L327 786L275 786Z" fill="url(#cb-satin)"/><path d="M144 288L853 288L861 332L138 332Z" fill="url(#cb-satin-cross)"/><path d="M275 786L327 786L322 828L281 828Z" fill="url(#cb-satin)"/><path d="M138 332L144 288L140 321L132 363Z" fill="'+dark+'"/></g><g fill="'+'url(#cb-ribbon-foil)'+'" font-family="Georgia,serif" font-size="23" text-anchor="middle"><text class="cb-ribbon-label" x="590" y="318">'+label+'</text><text class="cb-ribbon-label" transform="translate(307 585) rotate(92)">'+label+'</text></g><g stroke="'+dark+'" stroke-width="2" stroke-opacity=".5"><path d="M315 305Q280 350 228 425L254 413L272 442Q300 380 331 316" fill="url(#cb-satin)"/><path d="M320 308Q370 331 420 404L390 399L379 424Q343 366 312 329" fill="url(#cb-satin)"/><path d="M312 306C250 315 176 267 208 235C238 205 300 259 321 299C290 280 245 257 233 269C225 285 278 295 312 306Z" fill="url(#cb-satin)"/><path d="M324 302C325 251 357 174 391 203C422 237 368 297 324 312C346 283 381 239 368 229C350 222 337 279 324 302Z" fill="url(#cb-satin)"/><path d="M303 294Q320 285 339 301L333 327Q315 336 301 316Z" fill="url(#cb-satin)"/></g></svg>';
  }
  function personalGiftPreview(){
    const b=box(),animate=animateRibbonPreview&&b.ribbon!=='Geen lint';
    animateRibbonPreview=false;
    return '<p class="cb-gift-recipient">'+esc(boxName(b))+'</p><div class="cb-gift-composition cb-gift-no-card"><div class="cb-gift-box"><div class="cb-tray cb-model-tray cb-personal-box" data-lid-closed="true" '+(closeOnPersonalEntry?'data-lid-close-animate="true" ':'')+(animate?'':'data-ribbon-instant="true" ')+(b.ribbon!=='Geen lint'?'data-ribbon-text="'+esc(b.ribbonText||'Voor jou')+'" ':'')+'data-box-size="'+b.size+'" data-box-color-name="'+b.color+'" data-box-color="'+colors.find(c=>c[0]===b.color)[2]+'" role="img" aria-label="'+esc(colorName(b))+' gesloten cadeaudoos">'+selectedTraySlots()+'</div></div></div><p class="cb-gift-meta">'+b.size+' bonbons · '+esc(colorName(b))+'</p>';
  }
  function renderGiftPersonal(){
    const b=box();
    return '<div class="cb-personal-composition">'+intro('Maak het persoonlijk','')+'<div class="cb-gift-editor"><aside class="cb-gift-scene" aria-label="Voorbeeld van je cadeau">'+personalGiftPreview()+'</aside><div class="cb-gift-fields">'+
      '<div class="cb-personal-choices"><label class="cb-checkline"><input type="checkbox" id="cb-card" '+(b.card?'checked':'')+' '+(!config.products.card.available?'disabled':'')+'><span>Kaartje <span class="cb-choice-price">+ '+cash(config.products.card.price)+'</span></span></label><label class="cb-checkline"><input type="checkbox" id="cb-white-ribbon" '+(b.ribbon!=='Geen lint'?'checked':'')+' '+(!config.products.ribbon.available?'disabled':'')+'><span>Wit lint <span class="cb-choice-price">+ '+cash(config.products.ribbon.price)+'</span></span></label></div>'+
      '<section class="cb-personal-option" aria-label="Je kaartje">'+
      (b.card?'<label class="cb-ribbon-input-label" for="cb-message">Tekst op je kaartje</label><div class="cb-card-draft"><textarea id="cb-message" maxlength="180" placeholder="Schrijf iets liefs…">'+esc(b.message)+'</textarea><img src="'+esc(A.logo)+'" alt="Cacaoboetiek"></div><div class="cb-gift-field-meta"><button type="button" class="cb-text-button" data-action="suggest-message">Tekstideeën</button><span id="cb-charcount">'+b.message.length+'/180</span></div>':'')+'</section>'+
      '<section class="cb-personal-option" aria-label="Je lint">'+
      (b.ribbon!=='Geen lint'?'<label class="cb-ribbon-input-label" for="cb-ribbon-text">Tekst op je lint <span class="cb-muted">· optioneel</span></label><div class="cb-ribbon-draft"><input id="cb-ribbon-text" maxlength="40" value="'+esc(b.ribbonText)+'" placeholder="'+esc(b.name.trim()?'Voor jou, '+b.name.trim():'Voor jou')+'"></div><div class="cb-gift-field-meta"><span class="cb-ribbon-actions"><button type="button" class="cb-text-button" data-action="suggest-ribbon">Tekstideeën</button><button type="button" class="cb-text-button" data-action="replay-ribbon">Speel strik af</button></span><span id="cb-ribbon-count">'+b.ribbonText.length+'/40</span></div>':'')+'</section></div></div></div>';
  }
  function renderPersonal(){
    if(route==='gift')return renderGiftPersonal();
    const b=box();
    return intro('Maak het persoonlijk','Een paar woorden maken het cadeau van jou')+
    (route==='curated'?'<p class="cb-note">'+esc(b.occasion)+' · '+colorName(b)+'<br>Wij stellen '+b.size+' bonbons samen. Je kunt hieronder een gepersonaliseerd kaartje en lintje toevoegen.</p>'+allergies():'<div class="cb-field"><label class="cb-label" for="cb-occasion">Wat is de gelegenheid?<span>Optioneel</span></label><select id="cb-occasion" class="cb-input">'+['Zomaar','Verjaardag','Bedankt','Beterschap','Gefeliciteerd','Feestdagen','Ik hou van jou','Veel geluk'].map(o=>'<option '+(b.occasion===o?'selected':'')+'>'+o+'</option>').join('')+'</select><div class="cb-hint">Daarmee helpen we je met het kaartje en lint.</div></div>')+
    '<label class="cb-checkline"><input type="checkbox" id="cb-card" '+(b.card?'checked':'')+' '+(!config.products.card.available?'disabled':'')+'>Gepersonaliseerd kaartje <span class="cb-muted cb-small">+ '+cash(config.products.card.price)+'</span></label>'+
    (b.card?'<div class="cb-row"><label class="cb-label" for="cb-message">Jouw boodschap</label><span class="cb-small cb-muted" id="cb-charcount">'+b.message.length+'/180</span></div><textarea id="cb-message" class="cb-input" maxlength="180" placeholder="Schrijf iets liefs…">'+esc(b.message)+'</textarea><div class="cb-row" style="margin-top:10px"><button type="button" class="cb-text-button" data-action="suggest-message">Suggestie voor '+esc(who())+'</button><span class="cb-small cb-muted">'+esc(b.occasion)+'</span></div>':'<p class="cb-small cb-muted">Je kunt deze stap ook overslaan.</p>')+
    '<hr class="cb-separator"><div class="cb-row"><span class="cb-label">Gepersonaliseerd lintje</span><span class="cb-small cb-muted">Optioneel · + '+cash(config.products.ribbon.price)+'</span></div><div class="cb-ribbons">'+[['Geen lint','transparent'],['Wit','#fffdf8'],['Champagne','#d9c9aa'],['Bordeaux','#72353e']].map(([name,c])=>'<button type="button" class="cb-ribbon" data-ribbon="'+name+'" '+(name!=='Geen lint'&&!config.products.ribbon.available?'disabled':'')+' aria-pressed="'+(b.ribbon===name)+'">'+(name==='Geen lint'?'<span class="cb-ribbon-none">—</span>':'<span class="cb-ribbon-sample" style="--ribbon-color:'+c+'"></span>')+name+'</button>').join('')+'</div><p class="cb-hint">Een lintje met jouw eigen tekst voor de '+colorName(b).toLowerCase()+' doos.</p>'+(b.ribbon!=='Geen lint'?'<div class="cb-field" style="margin-top:20px"><label class="cb-label" for="cb-ribbon-text">Tekst op je lint<span>Optioneel</span></label><input id="cb-ribbon-text" class="cb-input" value="'+esc(b.ribbonText)+'" maxlength="40" placeholder="Bijvoorbeeld: Voor jou, Noor"><button class="cb-text-button" type="button" data-action="suggest-ribbon" style="margin-top:8px">Suggestie voor '+esc(who())+'</button></div>':'');
  }
  function renderSummary(){
    const b=box();
    const row=(label,value)=>'<div class="cb-summary-line"><dt>'+label+'</dt><dd>'+value+'</dd></div>';
    return intro(route!=='self'?'Klaar om te geven':'Helemaal naar jouw smaak','Bekijk je keuzes en pas ze aan als je wilt')+
    '<dl class="cb-summary-list">'+row(route!=='self'?'Ontvanger':'Jouw doos',esc(boxName(b)))+row('Formaat',b.size+' bonbons')+row('Kleur',colorName(b))+row('Bonbons',route==='curated'?'Door Cacaoboetiek samengesteld · '+b.size+' bonbons':flavors.map((f,i)=>b.counts[i]?b.counts[i]+'× '+esc(f.name):'').filter(Boolean).join('<br>'))+(route==='curated'?row('Gelegenheid',esc(b.occasion)):'')+row('Allergenen',esc(allergyText(b)))+(route!=='self'?row('Kaartje',b.card?(esc(b.message)||'Nog geen tekst'):'Geen kaartje')+row('Lint',esc(b.ribbon))+(b.ribbon!=='Geen lint'&&b.ribbonText?row('Tekst op lint',esc(b.ribbonText)):''):'')+'</dl>'+
    (b.card&&!b.message.trim()?'<p class="cb-note">Je kaartje heeft nog geen tekst. Voeg je boodschap toe bij Persoonlijk.</p>':'');
  }
  function renderFooter(){
    const b=box(),last=b.step===steps().length-1;
    const needCount=route!=='curated'&&b.step===1&&total()!==b.size;
    let label=b.step===0?(route==='curated'?'Maak het persoonlijk':b.boxPanel==='size'?(route!=='self'&&b.name.trim()?'Kies de kleur voor '+esc(b.name.trim()):'Verder met kleur'):(route!=='self'&&b.name.trim()?'Kies bonbons voor '+esc(b.name.trim()):'Kies je bonbons')):b.step===1?(route!=='self'?'Maak het persoonlijk':'Bekijk je doos'):last?(b.editing!==null?'Bewaar je wijzigingen':'Voeg toe aan je winkelmand'):'Bekijk je cadeau';
    const invalid=(b.step>=1&&blocked())||!config.products[String(b.size)]?.available||(last&&Core.validate(toCore(b),config,flavors).length>0);
    const guided=b.step===0;
    const extras=b.card&&b.ribbon!=='Geen lint'?'Met gepersonaliseerd kaartje en lintje':b.card?'Met gepersonaliseerd kaartje':b.ribbon!=='Geen lint'?'Met gepersonaliseerd lintje':route==='self'?'Bonbons en doos inbegrepen':'Zonder kaartje en lintje';
    const price=guided?'<div class="cb-guided-total"><div class="cb-price"><span class="cb-total-label">Totaal</span><strong>'+cash(cost(b))+'</strong></div><span class="cb-footer-note cb-included-note">'+extras+'</span></div>':'<div><div class="cb-price"><strong>'+cash(cost(b))+'</strong><span class="cb-small cb-muted">'+b.size+' bonbons</span></div><span class="cb-footer-note cb-price-breakdown">'+(route==='gift'&&b.step>=2?'Doos '+cash(cost({...b,card:false,ribbon:'Geen lint'}))+(b.card?' · Kaartje +'+cash(config.products.card.price):'')+(b.ribbon!=='Geen lint'?' · Lint +'+cash(config.products.ribbon.price):''):'Inclusief gekozen extra’s')+' </span></div>';
    if(advisor){
      el('cb-footer').innerHTML=price+'<div class="cb-footer-actions"><button type="button" class="cb-text-button" data-action="close-advisor">Terug naar bonbons</button><button type="button" class="cb-primary" data-action="apply-proposal" '+(!proposal||!sum(proposal)||blocked()?'disabled':'')+'>Neem mijn selectie over '+icon('check')+'</button></div>';return;
    }
    el('cb-footer').innerHTML=price+'<div class="cb-footer-actions">'+(b.step?'<button type="button" class="cb-text-button" data-action="previous">Terug</button>':route!=='curated'?'<button type="button" class="cb-text-button" data-action="'+(b.boxPanel==='color'?'box-size':route==='gift'?'recipient':'purpose')+'">Terug</button>':'')+'<button type="button" class="cb-primary" data-action="next" '+(needCount||invalid||busy?'disabled':'')+'>'+(busy?'Even geduld…':label)+icon('arrow-right')+'</button></div>'+'<div class="cb-footer-note" data-remaining '+(needCount?'':'hidden')+'>Nog '+(b.size-total())+' bonbons te kiezen.</div>'+(feedback?'<p class="cb-feedback" role="alert">'+esc(feedback)+'</p>':'');
  }
  // Quantity clicks keep the catalog, decoded photos, tray and focus mounted.
  function updateQuantities(addedFlavor){
    const b=box(),chosen=total(),pieces=trayPieces();
    el('cb-preview').querySelector('.cb-closing-lid')?.remove();
    el('cb-preview').querySelector('.cb-candy-paper')?.remove();
    const lidButton=el('cb-preview').querySelector('.cb-lid-toggle');
    if(lidButton){lidButton.textContent='Deksel erop';lidButton.setAttribute('aria-pressed','false');}
    root.querySelectorAll('[data-flavor-row]').forEach(row=>{
      const i=Number(row.dataset.flavorRow),canAdd=available(i);
      const count=row.querySelector('[data-quantity]');
      const changed=count.textContent!==String(b.counts[i]||0);
      count.textContent=b.counts[i]||0;
      if(changed&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){count.getAnimations().forEach(a=>a.cancel());count.animate([{transform:'scale(1)'},{transform:'scale(1.07)'},{transform:'scale(1)'}],{duration:260,easing:'cubic-bezier(.22,1,.36,1)'});}
      row.classList.toggle('cb-chosen',b.counts[i]>0);
      row.querySelector('[data-minus]').disabled=!b.counts[i];
      row.querySelector('[data-plus]').disabled=chosen>=b.size||!canAdd;
      {const u=row.querySelector('.cb-flavor-unavailable');u.hidden=canAdd;u.textContent=uitTekst(i);}
    });
    const tray=el('cb-preview').querySelector('.cb-tray');
    delete tray.dataset.autoOpen;
    tray.setAttribute('aria-label',chosen+' van '+b.size+' bonbons gekozen');
    Array.from(tray.querySelectorAll('.cb-slot')).forEach((slot,j)=>{
      const piece=pieces[j],key=String(piece?.i??'');
      if(slot.dataset.flavor!==key){slot.innerHTML=slotContent(piece);slot.dataset.flavor=key;}
      slot.classList.toggle('cb-proposed',Boolean(piece?.proposed));
    });
    if(addedFlavor!==undefined&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      const image=tray.querySelectorAll('.cb-slot')[packingSlot(chosen-1,b.size)]?.querySelector('img');
      if(image)image.animate([
        {transform:'translateY(-9px) scale(1.035)',opacity:.4},
        {transform:'translateY(0) scale(1)',opacity:1}
      ],{duration:340,easing:'cubic-bezier(.2,.7,.25,1)'});
    }
    el('cb-preview').querySelector('[data-chosen-count]').textContent=chosen+' van '+b.size;
    el('cb-preview').querySelector('.cb-progress span').style.width=Math.min(100,chosen/b.size*100)+'%';
    const footer=el('cb-footer'),remaining=footer.querySelector('[data-remaining]');
    remaining.textContent=b.size-chosen===1?'Nog één bonbon te kiezen.':'Nog '+(b.size-chosen)+' bonbons te kiezen.';
    remaining.hidden=chosen===b.size;
    footer.querySelector('[data-action="next"]').disabled=chosen!==b.size||blocked()||!config.products[String(b.size)]?.available||busy;
    feedback='';footer.querySelector('.cb-feedback')?.remove();
    updateBoxStatus();saveDrafts();say(chosen===b.size?'Je doos is gevuld. Nog iets wisselen? Haal eerst een bonbon weg.':chosen+' van '+b.size+' bonbons gekozen.');
  }
  function renderCart(){
    el('cb-cart').innerHTML='<div class="cb-basket">'+intro('Jouw dozen','Ieder cadeau heeft zijn eigen samenstelling')+
    (basket.length?basket.map((b,i)=>'<article class="cb-basket-item"><img src="'+A['box-'+b.color]+'" alt="'+colorName(b)+' doos"><div><h2>'+esc(boxName(b))+'</h2><p>'+b.size+' bonbons · '+colorName(b)+(b.quantity>1?' · '+b.quantity+' dozen':'')+'</p><p>Allergenen: '+esc(allergyText(b))+'</p>'+(b.card?'<p>Met persoonlijk kaartje</p>':'')+(b.ribbon!=='Geen lint'?'<p>'+esc(b.ribbon)+' lint'+(b.ribbonText?' · '+esc(b.ribbonText):'')+'</p>':'')+'<button type="button" class="cb-text-button" data-edit="'+i+'" '+(busy||b.quantity!==1?'disabled':'')+'>Aanpassen</button><button type="button" class="cb-text-button" data-delete="'+i+'" '+(busy?'disabled':'')+'>Verwijderen</button></div><div class="cb-basket-price">'+cash(b.linePrice)+'</div></article>').join(''):'<p class="cb-muted">Je hebt nog geen samengestelde doos toegevoegd.</p>')+
    '<div class="cb-basket-bottom"><button type="button" class="cb-secondary" data-action="new-gift" '+(busy?'disabled':'')+'>'+icon('plus')+' Nog een cadeau samenstellen</button><button type="button" class="cb-checkout" data-action="store-cart">Open je winkelmand '+icon('arrow-right')+'</button></div>'+
    (cartSnapshot?'<div class="cb-row" style="margin-top:20px"><span class="cb-small cb-muted">Totaal winkelmand, inclusief andere artikelen</span><span class="cb-basket-price">'+cash(cartSnapshot.total_price)+'</span></div>':'')+
    (feedback?'<p class="cb-feedback" role="alert">'+esc(feedback)+'</p>':'')+'<div class="cb-link-row"><button class="cb-text-button" type="button" data-action="continue">Verder samenstellen</button></div></div>';
  }
  function fromStored(data){
    const b=createBox(['self','curated'].includes(data.route)?data.route:'gift',Number(data.number)||1);
    b.uid=typeof data.uid==='string'?data.uid:b.uid;b.editing=typeof data.editing==='string'?data.editing:null;b.name=String(data.name||'').slice(0,40);
    b.size=[16,25].includes(Number(data.size))?Number(data.size):16;b.color=colors.some(c=>c[0]===data.color)?data.color:'bordeaux';
    b.counts=flavors.map(f=>Number.isInteger(data.counts?.[f.id])&&data.counts[f.id]>=0?data.counts[f.id]:0);
    b.packingOrder=Array.isArray(data.packingOrder)?data.packingOrder.filter(id=>typeof id==='string'):[];
    b.allergyMode=['none','unknown','select'].includes(data.allergyMode)?data.allergyMode:'unset';
    b.allergens=Array.isArray(data.allergens)?data.allergens.filter(a=>allergenOptions.some(x=>x[0]===a)):[];
    b.occasion=['Zomaar','Verjaardag','Bedankt','Beterschap','Gefeliciteerd','Feestdagen','Ik hou van jou','Veel geluk'].includes(data.occasion)?data.occasion:'Zomaar';
    b.prefs=Array.isArray(data.prefs)?data.prefs.filter(t=>tasteOptions.includes(t)):[];b.intensity=[1,2,3].includes(data.intensity)?data.intensity:2;
    b.card=Boolean(data.card);b.message=String(data.message||'').slice(0,180);b.ribbon=['Wit','Champagne','Bordeaux'].includes(data.ribbon)?data.ribbon:'Geen lint';b.ribbonText=String(data.ribbonText||'').slice(0,40);
    b.step=Number.isInteger(data.step)&&data.step>=0&&data.step<(b.route==='self'?3:4)?data.step:0;
    b.boxPanel=data.boxPanel==='color'?'color':'size';
    b.favoriteIds=Array.isArray(data.favoriteIds)?[...new Set(data.favoriteIds)].filter(id=>flavors.some(f=>f.id===id)):[];
    return b;
  }
  const storageKey='cbx-configurator-drafts:v1';
  let draftSaveTimer;
  function flushDrafts(){clearTimeout(draftSaveTimer);try{localStorage.setItem(storageKey,JSON.stringify({time:Date.now(),route,boxes:{gift:toCore(boxes.gift),self:toCore(boxes.self),curated:toCore(boxes.curated)}}));}catch{}}
  function saveDrafts(){clearTimeout(draftSaveTimer);draftSaveTimer=setTimeout(flushDrafts,180);}
  function restoreDrafts(){try{const saved=JSON.parse(localStorage.getItem(storageKey)||sessionStorage.getItem(storageKey));if(saved&&Date.now()-saved.time<7*24*60*60*1000){['gift','self','curated'].forEach(r=>{if(saved.boxes?.[r])boxes[r]=fromStored(saved.boxes[r]);});route=['self','curated'].includes(saved.route)?saved.route:'gift';}}catch{}}
  function useCart(cart){
    cartSnapshot=cart;basket=[];
    for(const item of cart.items||[]){
      if(item.properties?._cbx_role!=='box')continue;
      try{
        const b=fromStored(JSON.parse(item.properties._cbx_configuration));b.uid=item.properties._cbx_id;b.key=item.key;b.quantity=item.quantity;
        const group=cartAPI.group(cart,b.uid),card=group.find(i=>i.properties._cbx_role==='card'),ribbon=group.find(i=>i.properties._cbx_role==='ribbon');
        b.card=Boolean(card);b.message=card?.properties.Boodschap||'';b.ribbon=ribbon?.properties.Lintkleur||'Geen lint';b.ribbonText=ribbon?.properties.Tekst||'';
        b.linePrice=group.reduce((p,i)=>p+i.final_line_price,0);basket.push(b);
      }catch{}
    }
  }
  async function showCart(){busy=true;feedback='';cartOpen=true;render();try{useCart(await cartAPI.get());}catch(e){feedback=e.message;}finally{busy=false;render();}}
  async function notifyCart(openingDrawer=false){
    document.dispatchEvent(new CustomEvent('cart:updated',{detail:{cart:cartSnapshot}}));
    if(typeof document.querySelector('cbx-winkelmand')?.open==='function'){
      if(!openingDrawer)document.dispatchEvent(new CustomEvent('cbx-cart:refresh'));
      return;
    }
    document.dispatchEvent(new CustomEvent('cart:refresh'));
    try{
      const response=await fetch((window.Shopify?.routes?.root||'/')+'?sections=cart-drawer-section',{credentials:'same-origin'});
      const sections=await response.json(),html=sections['cart-drawer-section'];
      const current=document.getElementById('shopify-section-cart-drawer-section');
      if(html&&current){const dom=new DOMParser().parseFromString(html,'text/html');const next=dom.getElementById('shopify-section-cart-drawer-section');if(next)current.replaceWith(next);}
    }catch{}
  }
  function nextNumber(){return Math.max(0,...basket.filter(b=>b.route!=='self').map(b=>b.number))+1;}
  function openStoreCart(){
    const drawer=document.querySelector('cbx-winkelmand');
    if(typeof drawer?.open!=='function')return false;
    const trigger=document.querySelector('[data-cbx-cart-link]')||lastTrigger;
    lastTrigger=null;
    close();
    drawer.open(trigger);
    return true;
  }
  async function submitBox(){
    if(busy)return;
    const b=box(),errors=Core.validate(toCore(b),config,flavors);
    if(errors.length){feedback=errors.join(' ');render();return;}
    busy=true;feedback='';render();
    let added=false;
    try{
      // Re-read catalog through Shopify's section renderer before committing.
      const response=await fetch((window.Shopify?.routes?.root||'/')+'?section_id='+encodeURIComponent(config.sectionId),{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('De beschikbaarheid kon niet worden gecontroleerd. Probeer het opnieuw.');
      const dom=new DOMParser().parseFromString(await response.text(),'text/html');
      const freshNode=dom.querySelector('[data-cbx-data]');if(!freshNode)throw new Error('Het assortiment kon niet worden gecontroleerd. Probeer opnieuw.');
      const fresh=JSON.parse(freshNode.textContent),freshFlavors=Core.normalize(fresh.flavors,overrides);
      const oldPrice=cost(b);flavors.forEach(f=>{const current=freshFlavors.find(item=>item.id===f.id);if(current)Object.assign(f,current);else f.available=false;});Object.assign(config.products,fresh.products);config.allergensVerified=fresh.allergensVerified;config.crossContact=fresh.crossContact;
      if(oldPrice!==Core.totalPrice(toCore(b),config))throw new Error('De prijs is gewijzigd. Controleer het nieuwe totaal en voeg je doos opnieuw toe.');
      const checked=Core.validate(toCore(b),config,freshFlavors);if(checked.length)throw new Error(checked.join(' '));
      const transactionBox={...toCore(b),uid:b.editing?newId():b.uid};
      const result=await cartAPI.add(Core.payload(transactionBox,config,freshFlavors),b.editing);
      useCart(result);boxes[route]=createBox(route,nextNumber());cartOpen=true;saveDrafts();await notifyCart(true);added=true;say('Je doos is toegevoegd aan je winkelmand.');
    }catch(e){feedback=e.message;}
    finally{busy=false;render();if(added)openStoreCart();}
  }
  async function removeBox(index){if(busy)return;busy=true;feedback='';render();try{useCart(await cartAPI.remove(basket[index].uid));await notifyCart();}catch(e){feedback=e.message;}finally{busy=false;render();}}
  function editBox(index){const b=basket[index];if(!b||b.quantity!==1)return;route=b.route;boxes[route]={...b,counts:[...b.counts],allergens:[...b.allergens],prefs:[...b.prefs],editing:b.uid,step:0,boxPanel:'size'};cartOpen=false;advisor='';proposal=null;render();}
  function close(){if(busy){feedback='Wacht even tot je doos is verwerkt.';render();return;}flushDrafts();dialog.close();}
  function confirmRecipientSkip(trigger){
    const prompt=document.createElement('dialog');
    prompt.className='cb-inspect cb-resume-prompt';
    prompt.setAttribute('aria-label','Doorgaan zonder naam?');
    prompt.innerHTML='<h2>Doorgaan zonder naam?</h2><p>Je kunt nog de naam van de ontvanger invullen.</p><form method="dialog" class="cb-resume-actions"><button type="submit" class="cb-secondary" value="skip">Doorgaan zonder naam</button><button type="submit" class="cb-primary" value="name" autofocus>Naam invullen</button></form>';
    prompt.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();prompt.close();});
    prompt.addEventListener('close',()=>{
      prompt.remove();
      if(!dialog.open)return;
      if(prompt.returnValue==='skip'){
        showBoxPanel('size');
      }else if(prompt.returnValue==='name'){
        el('cb-name')?.focus();
      }else{
        trigger.focus({preventScroll:true});
      }
    },{once:true});
    root.append(prompt);
    prompt.showModal();
  }
  let resumePrompt=null;
  function hasDraft(b){return !b.editing&&(b.step>0||b.size!==16||b.color!=='lichtblauw'||b.name.trim()||b.message.trim()||b.ribbonText.trim()||b.counts.some(n=>n>0)||b.allergyMode!=='unset');}
  function open(targetRoute,step,trigger,focus){
    if(busy||resumePrompt)return;
    if(targetRoute==='choose'){openDirect('self',0,trigger,focus);return;}
    const requested=['gift','self','curated'].includes(targetRoute)?targetRoute:route;
    if(!dialog.open&&targetRoute!==null&&requested!=='curated'&&hasDraft(boxes[requested])){
      const prompt=document.createElement('dialog');resumePrompt=prompt;
      prompt.className='cb-inspect cb-resume-prompt';prompt.setAttribute('aria-label','Je vorige samenstelling');
      const b=boxes[requested],chosen=sum(b.counts);
      prompt.innerHTML='<button type="button" class="cb-inspect-close" aria-label="Sluiten">×</button><h2>Verder met je doos?</h2><p>Je vorige samenstelling staat nog voor je klaar.</p><p class="cb-resume-summary">'+b.size+' bonbons · '+esc(colorName(b))+(chosen?' · '+chosen+' gekozen':'')+'</p><div class="cb-resume-actions"><button type="button" class="cb-button" data-resume>Hervatten</button><button type="button" class="cb-text-button" data-restart>Opnieuw beginnen</button></div>';
      const finish=resume=>{prompt.close();resumePrompt=null;if(!resume)boxes[requested]=createBox(requested,nextNumber());route=requested;openDirect(requested,resume?null:step,trigger,resume?null:focus);};
      prompt.querySelector('[data-resume]').addEventListener('click',()=>finish(true));prompt.querySelector('[data-restart]').addEventListener('click',()=>finish(false));prompt.querySelector('.cb-inspect-close').addEventListener('click',()=>prompt.close());
      prompt.addEventListener('click',e=>{if(e.target===prompt){const r=prompt.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)prompt.close();}});
      prompt.addEventListener('close',()=>{prompt.remove();if(resumePrompt===prompt){resumePrompt=null;trigger?.focus?.({preventScroll:true});}},{once:true});
      prompt.addEventListener('cancel',e=>{e.preventDefault();e.stopPropagation();prompt.close();});
      openDirect(requested,null,trigger,null);root.append(prompt);prompt.showModal();return;
    }
    openDirect(targetRoute,step,trigger,focus);
  }
  function openDirect(targetRoute,step,trigger,focus){
    if(busy)return;
    if(['gift','self','curated'].includes(targetRoute))route=targetRoute;
    if(targetRoute==='auto'&&route==='curated')route='gift';
    if(Number.isInteger(step))box().step=step;
    if(box().step===0&&(Number.isInteger(step)||focus==='color'))box().boxPanel=focus==='color'?'color':'size';
    if(route!=='curated'&&box().step===0&&focus!=='color')box().boxPanel='purpose';
    advisor='';proposal=null;cartOpen=false;feedback='';lastTrigger=trigger||document.activeElement;render();
    if(!dialog.open)dialog.showModal();document.documentElement.classList.add('cbx-config-open');
    dialog.scrollTop=0;root.querySelector('[data-action="close"]').focus({preventScroll:true});
    if(focus==='color'){const swatch=root.querySelector('.cb-color-card[aria-pressed="true"]');swatch?.focus();swatch?.scrollIntoView({block:'center'});}
    else root.querySelector('.cb-content h1')?.scrollIntoView({block:'nearest'});
  }
  root.cbxOpenOccasion=(choice,trigger)=>{
    if(busy||!colors.some(c=>c[0]===choice.color))return;
    const b=boxes.curated;
    if(b.editing){boxes.curated=createBox('curated',nextNumber());}
    boxes.curated.color=choice.color;boxes.curated.occasion=choice.name;
    open('curated',0,trigger);
  };
  root.cbxOpenFromTasting=(ids,trigger)=>{
    if(busy)return;
    // Bookmarks do not change order quantities, recipient data, or other drafts.
    if(boxes.self.editing)boxes.self=createBox('self');
    boxes.self.favoriteIds=[...new Set(Array.isArray(ids)?ids:[])].filter(id=>flavors.some(f=>f.id===id&&f.available&&f.stock!==0));
    open('self',0,trigger);
  };
  root.cbxOpen=open;root.cbxEdit=async uid=>{open(null,null,null);await showCart();const index=basket.findIndex(b=>b.uid===uid);if(index>=0)editBox(index);else{feedback='Deze doos staat niet meer in je winkelmand.';render();}};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{enhanceBox3D();document.documentElement.classList.remove('cbx-config-open');lastTrigger?.focus?.({preventScroll:true});});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();});
  function render({keepGiftScene=false}={}){
    root.querySelectorAll('.cb-allergy-portal').forEach(panel=>panel.remove());
    clearTimeout(mobileScrollTimer);root.classList.remove('cb-steps-collapsed','cb-mobile-steps-open');el('cb-steps').inert=false;
    closeInspection();
    const active=document.activeElement;
    const focusData=active&&root.contains(active)&&active.tagName==='BUTTON'?Object.entries(active.dataset):[];
    el('cb-brand').src=A.logo;root.setAttribute('aria-busy',String(busy));saveDrafts();
    const guided=!cartOpen&&box().step===0;
    const purpose=guided&&['purpose','recipient'].includes(box().boxPanel)&&route!=='curated';root.classList.toggle('cb-purpose-entry',purpose);
    root.classList.toggle('cb-bonbonbar',!cartOpen&&box().step===1&&route!=='curated');
    root.classList.toggle('cb-advising',!!advisor);
    dialog.classList.toggle('cbx-bar-dialog',root.classList.contains('cb-bonbonbar'));
    root.classList.toggle('cb-guided',guided);
    root.classList.toggle('cb-size-panel',guided&&box().boxPanel!=='color');
    root.classList.toggle('cb-color-panel',guided&&box().boxPanel==='color');dialog.classList.toggle('cbx-guided-dialog',guided);
    const giftPersonal=!cartOpen&&route==='gift'&&box().step===2;
    root.classList.toggle('cb-gift-personal',giftPersonal);if(!giftPersonal)root.classList.remove('cb-card-packed');
    el('cb-preview').hidden=guided||giftPersonal;
    root.querySelector('[data-action="edit-recipient"]').hidden=route==='self'||cartOpen;
    el('cb-self-label').hidden=route!=='self'||cartOpen;
    updateRecipientHeader();
    root.querySelectorAll('[data-route]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.route===route)));
    const bag=root.querySelector('[data-action="basket"]');
    if(!bag.querySelector('.cb-bag-bonbon'))bag.insertAdjacentHTML('afterbegin','<svg class="cb-bag-bonbon" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 21L32 10L54 21V47L32 58L10 47Z M10 21L32 32L54 21 M32 32V58"/></svg>');
    el('cb-bag-label').textContent=matchMedia('(max-width:720px)').matches?String(basket.length):'Je dozen ('+basket.length+')';
    root.querySelector('[data-action="basket"]').setAttribute('aria-label','Je dozen ('+basket.length+')');
    root.classList.toggle('cb-recipient-named',Boolean(box().name.trim()));
    el('cb-layout').hidden=cartOpen;el('cb-steps').hidden=cartOpen;el('cb-footer').hidden=cartOpen;el('cb-cart').hidden=!cartOpen;
    if(cartOpen){root.querySelector('.cb-step-compact')?.setAttribute('hidden','');renderCart();}
    else{
      renderSteps();
      if(!guided)renderPreview();
      const giftScene=keepGiftScene&&giftPersonal?root.querySelector('.cb-gift-scene'):null;
      if(giftScene){
        const editor=document.createElement('template');editor.innerHTML=renderGiftPersonal();
        root.querySelector('.cb-gift-fields').replaceWith(editor.content.querySelector('.cb-gift-fields'));
      }else el('cb-main').innerHTML=box().step===0?renderDoos():box().step===1?renderFlavors():route!=='self'&&box().step===2?renderPersonal():renderSummary();
      if(box().step===0&&box().boxPanel==='size'&&tasteFavorites().length)el('cb-main').querySelector('.cb-guided-body')?.insertAdjacentHTML('beforeend',favoritesNotice());
      renderFooter();if(purpose){el('cb-footer').hidden=true;el('cb-self-label').hidden=true;root.querySelector('[data-action="edit-recipient"]').hidden=true;}if(guided||(giftPersonal&&!giftScene))enhanceBox3D();if(giftPersonal)requestAnimationFrame(observeGiftCard);
    }
    
    root.querySelector('.cb-mobile-filters')?.remove();
    if(root.classList.contains('cb-bonbonbar')&&!advisor){const filters=el('cb-main').querySelector('.cb-inline-filters')?.cloneNode(true);if(filters){filters.classList.add('cb-mobile-filters');el('cb-layout').before(filters);}}
    positionAllergy();
    if(focusData.length){const nextFocus=Array.from(root.querySelectorAll('button')).find(e=>focusData.every(([k,v])=>e.dataset[k]===v));if(nextFocus&&!nextFocus.disabled)nextFocus.focus({preventScroll:true});}
  }
  async function go(step,panel='size'){
    if(busy)return;
    if(step<0||step>=steps().length)return;
    if(route==='curated'&&step===1)step=0;
    feedback='';proposal=null;advisor='';detail=null;
    if(step>1&&((route!=='curated'&&total()!==box().size)||blocked())){feedback=route!=='curated'&&total()!==box().size?'Kies precies '+box().size+' bonbons.':'Controleer de opgegeven allergenen.';box().step=route==='curated'?2:1;render();return;}
    const closingOnArrival=box().step===1&&step===2&&route==='gift';
    const opening=step===1&&box().step===0&&route!=='curated';
    closeOnPersonalEntry=closingOnArrival;
    box().step=step;if(step===0)box().boxPanel=panel;render();focusStep();say('Stap '+(step+1)+': '+steps()[step]);
    closeOnPersonalEntry=false;
    if(opening){
      const tray=el('cb-preview').querySelector('.cb-tray');
      if(!tray)return;
      tray.dataset.autoOpen='true';
      const deadline=performance.now()+1500;
      while(tray.isConnected&&tray.dataset.autoOpen&&!tray.cbxCloseLid&&performance.now()<deadline){
        await new Promise(requestAnimationFrame);
      }
      if(tray.isConnected&&tray.dataset.autoOpen&&tray.cbxCloseLid){
        delete tray.dataset.autoOpen;
        await tray.cbxCloseLid(true);
        if(tray.isConnected)await tray.cbxOpenLid();
      }else delete tray.dataset.autoOpen;
    }
  }
  function focusStep(){dialog.scrollTop=0;el('cb-main').querySelector('h1')?.focus({preventScroll:true});}
  function showBoxPanel(panel){box().step=0;box().boxPanel=panel;feedback='';advisor='';proposal=null;detail=null;cartOpen=false;render();focusStep();say(panel==='purpose'?'Voor wie stel je samen?':panel==='recipient'?'Voor wie is het cadeau?':panel==='color'?'Kies je kleur.':'Kies je formaat.');}
  function makeProposal(showAll=false){
    const focused=document.activeElement?.name==='preference'?document.activeElement.value:null;
    if(showAll)box().prefs=[];
    box().prefs=box().prefs.filter(t=>tasteOptions.includes(t));
    if(!advisor||!proposal)proposal=flavors.map(()=>0);
    const patterns={Karamel:/karamel|caramel|biscoff|stroopwafel/i,Noten:/noot|noten|hazel|pistach|pinda|amandel|pecan/i,Fruit:/fruit|kers|aardbei|bes|bessen|ananas|framboos|citroen|sinaasappel/i,Koffie:/koffie|coffee|cappuccino|espresso/i,Matcha:/matcha/i};
    const all=!box().prefs.length||box().prefs.length===tasteOptions.length;
    proposalChoices=flavors.map((f,i)=>i).filter(i=>Core.eligible(flavors[i],toCore(box()),config)&&(flavors[i].stock===null||flavors[i].stock>box().counts[i]||proposal[i]>0)&&(all||box().prefs.some(t=>patterns[t].test(flavors[i].name))));
    advisor='inline';feedback='';render();el('cb-main').scrollTop=0;
    if(focused)root.querySelector('input[name="preference"][value="'+focused+'"]')?.focus({preventScroll:true});
    else if(showAll)root.querySelector('[data-action="surprise"]')?.focus({preventScroll:true});
    say(proposalChoices.length+' smaken zichtbaar. Je gekozen aantallen blijven behouden.');
  }
  root.addEventListener('submit',e=>{
    if(!e.target.matches('[data-recipient-form]'))return;
    e.preventDefault();
    if(box().name.trim())showBoxPanel('size');
    else confirmRecipientSkip(e.submitter||e.target.querySelector('[type="submit"]'));
  });
  root.addEventListener('input',e=>{
    if(e.target.id==='cb-ribbon-text'){box().ribbonText=e.target.value;const count=el('cb-ribbon-count');if(count)count.textContent=e.target.value.length+'/40';renderPreview();saveDrafts();}

    if(e.target.id==='cb-name'){box().name=e.target.value;updateRecipientHeader();if(box().boxPanel!=='recipient')renderFooter();saveDrafts();}
    if(e.target.id==='cb-message'){box().message=e.target.value;el('cb-charcount').textContent=e.target.value.length+'/180';renderPreview();saveDrafts();}
  });
  root.addEventListener('change',e=>{
    const t=e.target,b=box();
    if(t.id==='cb-occasion'){b.occasion=t.value;render();el('cb-occasion').focus({preventScroll:true});return;}
    if(t.id==='cb-white-ribbon'){
      b.ribbon=t.checked?'Wit':'Geen lint';
      const tray=root.querySelector('.cb-personal-box');
      const reuseTray=tray&&(!tray.cbxStartRibbon||tray.cbxStopRibbon);
      if(reuseTray){
        if(t.checked){
          delete tray.dataset.ribbonInstant;
          tray.dataset.ribbonText=b.ribbonText||'Voor jou';
          tray.cbxStartRibbon?.();
        }else{
          delete tray.dataset.ribbonText;
          tray.cbxStopRibbon?.();
        }
      }else animateRibbonPreview=t.checked;
      render({keepGiftScene:Boolean(reuseTray)});
      el('cb-white-ribbon')?.focus({preventScroll:true});
      return;
    }
    if(t.id==='cb-card'){b.card=t.checked;render({keepGiftScene:true});el('cb-card')?.focus({preventScroll:true});return;}
    if(t.name==='allergy-mode'){allergyExpanded=true;b.allergyMode=t.value;if(t.value!=='select')b.allergens=[];proposal=null;render();}
    if(t.name==='allergen'){allergyExpanded=true;b.allergens=t.checked?[...new Set([...b.allergens,t.value])]:b.allergens.filter(a=>a!==t.value);b.allergyMode=b.allergens.length?'select':'unset';proposal=null;render();root.querySelector('input[name="allergen"][value="'+t.value+'"]')?.focus({preventScroll:true});}
    if(t.name==='preference'){b.prefs=t.checked?[...b.prefs,t.value]:b.prefs.filter(v=>v!==t.value);saveDrafts();makeProposal();}
  });
  root.addEventListener('click',e=>{
    let t=e.target.closest('button');
    // Tile taps use the existing add action; minus and info remain independent.
    if(!t&&root.classList.contains('cb-bonbonbar')&&!e.target.closest('a,input,select,textarea,label')){
      const row=e.target.closest('[data-flavor-row]');if(!row?.classList.contains('cb-card-flipped'))t=row?.querySelector('[data-plus]');
    }
    if(!t||t.disabled||busy)return;
    const b=box(),d=t.dataset;
    if(d.chocolateFilter){chocolateFilter=d.chocolateFilter;el('cb-main').querySelector('.cb-tastes').outerHTML=flavorList();root.querySelectorAll('[data-chocolate-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.chocolateFilter===chocolateFilter)));say('Chocoladefilter: '+chocolateFilter);return;}
    if(d.route){
      if(!['self','gift','curated'].includes(d.route))return;
      if(d.route===route){showBoxPanel(route==='gift'?'recipient':'size');return;}
      if(['self','gift'].includes(route)&&['self','gift'].includes(d.route)){
        const target=boxes[d.route];
        ['size','color','allergyMode','intensity','editing','uid'].forEach(key=>target[key]=b[key]);
        ['counts','allergens','prefs'].forEach(key=>target[key]=[...b[key]]);
        target.step=0;target.boxPanel='size';
      }
      route=d.route;box().boxPanel=route==='gift'?'recipient':'size';cartOpen=false;proposal=null;advisor='';feedback='';saveDrafts();render();
      focusStep();
      say(route==='gift'?'Als cadeau gekozen. Na je bonbons kun je een kaartje of lint toevoegen.':'Voor mezelf gekozen. Je formaat, kleur en bonbons blijven bewaard.');return;
    }
    if(d.step!==undefined){go(Number(d.step));return;}
    if(d.size){
      if(![16,25].includes(Number(d.size))||total()>Number(d.size))return;
      if(b.size===Number(d.size))return;
      b.size=Number(d.size);
      el('cb-main').querySelectorAll('[data-size]').forEach(card=>{
        const selected=Number(card.dataset.size)===b.size;
        card.setAttribute('aria-pressed',String(selected));
        card.querySelector('em').textContent=selected?'✓':'';
      });
      renderFooter();saveDrafts();
      return;
    }
    if(d.color){
      if(b.color===d.color)return;
      b.color=d.color;
      const summary=root.querySelector('[data-choice-summary]');if(summary)summary.textContent=b.size+' bonbons · '+colorName(b);
      root.querySelectorAll('.cb-color-card').forEach(card=>card.classList.remove('cb-color-chosen'));
      t.classList.add('cb-color-chosen');
      // Keep the decoded photos and focused button mounted while changing color.
      root.querySelectorAll('.cb-color-card').forEach(card=>{
        const selected=card.dataset.color===b.color;
        if(card.getAttribute('aria-pressed')===String(selected))return;
        card.setAttribute('aria-pressed',String(selected));
        card.querySelector('em').textContent=selected?'✓':'';
      });
      saveDrafts();
      return;
    }
    if(d.plus!==undefined&&advisor){const i=Number(d.plus);if(canAddProposal(i)){proposal[i]++;updateProposalTiles();}return;}
    if(d.minus!==undefined&&advisor){const i=Number(d.minus);if(proposal?.[i]>0){proposal[i]--;updateProposalTiles();}return;}
    if(d.plus!==undefined){const i=Number(d.plus);if(total()<b.size&&available(i)){packingOrder(b);b.packingOrder.push(flavors[i].id);b.counts[i]++;updateQuantities(i);}return;}
    if(d.minus!==undefined){const i=Number(d.minus);if(b.counts[i]>0){packingOrder(b);b.packingOrder.splice(b.packingOrder.lastIndexOf(flavors[i].id),1);b.counts[i]--;updateQuantities();}return;}
    if(d.flip!==undefined){
      const card=t.closest('.cb-flip-card');if(card.dataset.turning)return;
      const back=card.querySelector('.cb-card-back'),front=card.querySelector('.cb-card-front');
      const swap=()=>{const flipped=card.classList.toggle('cb-card-flipped');back.inert=!flipped;front.inert=flipped;back.setAttribute('aria-hidden',String(!flipped));front.setAttribute('aria-hidden',String(flipped));t.setAttribute('aria-pressed',String(flipped));t.setAttribute('aria-label',flipped?'Terug naar de bonbon':'Kaart omdraaien voor ingrediënten en allergenen');};
      if(card.classList.contains('cb-swatch-card')){openInspection('flavor',Number(d.flip));return;}
      if(matchMedia('(prefers-reduced-motion: reduce)').matches){swap();return;}
      card.dataset.turning='true';
      (async()=>{let first,second;try{
        first=card.animate([{transform:'perspective(900px) rotateY(0deg)'},{transform:'perspective(900px) rotateY(-90deg)'}],{duration:260,easing:'cubic-bezier(.42,0,1,1)',fill:'forwards'});await first.finished;swap();
        second=card.animate([{transform:'perspective(900px) rotateY(90deg)'},{transform:'perspective(900px) rotateY(0deg)'}],{duration:340,easing:'cubic-bezier(0,0,.22,1)',fill:'forwards'});first.cancel();await second.finished;
      }catch{}finally{first?.cancel();second?.cancel();delete card.dataset.turning;}})();return;
    }
    if(d.detail!==undefined){const back=t.closest('.cb-card-back');openInspection('flavor',Number(d.detail));if(back)inspection.querySelector('[data-flip]')?.click();return;}
    if(d.intensity){b.intensity=Number(d.intensity);render();return;}
    if(d.ribbon){b.ribbon=d.ribbon;render();return;}
    if(d.edit!==undefined){editBox(Number(d.edit));return;}
    if(d.delete!==undefined){removeBox(Number(d.delete));return;}
    switch(d.action){
      case 'toggle-mobile-steps':{const open=root.classList.toggle('cb-mobile-steps-open');el('cb-steps').inert=!open;t.setAttribute('aria-expanded',String(open));}break;
      case 'close-allergies':allergyExpanded=false;{const panel=t.closest('details')||root.querySelector('.cb-allergy-direct[open]');if(panel){panel.open=false;panel.querySelector('summary').focus({preventScroll:true});}}break;
      case 'inspect-box':if(advisor)break;openInspection('box');break;
      case 'clear-allergies':allergyExpanded=true;b.allergyMode='unset';b.allergens=[];proposal=null;render();break;
      case 'basket':showCart();break;
      case 'store-cart':if(!openStoreCart()){feedback='De winkelmand kan nu niet worden geopend.';render();}break;
      case 'close':close();break;
      case 'continue':cartOpen=false;render();break;
      case 'new-gift':route='gift';boxes.gift=createBox('gift',nextNumber());cartOpen=false;advisor='';proposal=null;feedback='';render();break;
      case 'previous':go(route==='curated'&&b.step===2?0:b.step-1,b.step===1?'color':'size');break;
      case 'purpose':showBoxPanel('purpose');break;
      case 'skip-recipient':
        if(route==='gift'&&b.step===0&&b.boxPanel==='recipient'){
          b.name='';
          showBoxPanel('size');
        }
        break;
      case 'recipient':showBoxPanel('recipient');break;
      case 'box-size':showBoxPanel('size');break;
      case 'change-occasion':{const chooser=dialog.closest('.shopify-section')?.querySelector('[data-cbx-occasions]');if(chooser?.cbxShowOccasions){close();chooser.cbxShowOccasions(lastTrigger)}}break;
      case 'edit-recipient':if(route!=='self'){root.classList.add('cb-recipient-open');showBoxPanel(route==='gift'?'recipient':'size');el('cb-name')?.focus();}break;
      case 'replay-ribbon':{
        const tray=root.querySelector('.cb-personal-box');
        if(tray?.cbxStartRibbon)tray.cbxStartRibbon(true);
        else say('De strik wordt nog geladen.');
        break;
      }
      case 'toggle-lid':{
        const tray=el('cb-preview').querySelector('.cb-tray'),lid=tray?.querySelector('.cb-closing-lid');
        if(tray)delete tray.dataset.autoOpen;
        if(lid){t.disabled=true;tray.cbxOpenLid().then(()=>{t.textContent='Deksel erop';t.setAttribute('aria-pressed','false');}).finally(()=>{t.disabled=false;});}
        else if(tray?.cbxCloseLid){t.disabled=true;tray.cbxCloseLid().then(()=>{t.textContent='Deksel eraf';t.setAttribute('aria-pressed','true');}).finally(()=>{t.disabled=false;});}
        break;
      }
      case 'next':
        if(route==='curated'&&b.step===0)go(2);else if(b.step===0&&b.boxPanel==='size')showBoxPanel('color');else if(b.step===steps().length-1)submitBox();else go(b.step+1);break;
      case 'advisor':makeProposal();el('cb-main').scrollTop=0;break;
      case 'close-advisor':advisor='';proposal=null;render();break;
      case 'adjust-advisor':makeProposal();break;
      case 'propose':makeProposal();break;
      case 'surprise':makeProposal(true);break;
      case 'apply-proposal':if(proposal&&sum(proposal)>0&&!blocked()&&total()+sum(proposal)<=b.size){b.counts=b.counts.map((n,i)=>n+proposal[i]);proposal=null;advisor='';render();say('Smaakvoorstel toegevoegd. '+total()+' van '+b.size+' bonbons gekozen.');}break;
      case 'close-detail':closeInspection();break;
      case 'suggest-ribbon':b.ribbonText=(b.name.trim()?'Voor jou, '+b.name.trim():b.occasion==='Bedankt'?'Dank je wel':'Met liefs').slice(0,40);render();break;
      case 'suggest-message':b.message=suggestedMessage().slice(0,180);render();say('Kaarttekst ingevuld. Je kunt de tekst aanpassen.');break;
    }
  });
  window.addEventListener('pagehide',flushDrafts);
  restoreDrafts();render();
  cartAPI.get().then(cart=>{
    useCart(cart);el('cb-bag-label').textContent=matchMedia('(max-width:720px)').matches?String(basket.length):'Je dozen ('+basket.length+')';
    const draft=boxes.gift;
    if(!draft.editing&&basket.some(b=>b.route!=='self'&&b.number===draft.number&&b.uid!==draft.uid)){
      draft.number=nextNumber();saveDrafts();if(route==='gift'&&!cartOpen){updateRecipientHeader();if(draft.step!==0)renderPreview();}
    }
  }).catch(()=>{});

  }
  function boot(scope=document){scope.querySelectorAll('[data-cbx-config]').forEach(mount);}
  boot();
  document.addEventListener('shopify:section:load',event=>boot(event.target));
  document.addEventListener('shopify:section:unload',event=>{event.target.querySelectorAll('[data-cbx-config]').forEach(root=>root.cbxDisconnectPreview?.());if(event.target.querySelector('[data-cbx-dialog][open]'))document.documentElement.classList.remove('cbx-config-open');});
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-cbx-open],[data-cbx-edit]');if(!trigger||event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const section=trigger.closest('.shopify-section');const root=section?.querySelector('[data-cbx-config]')||document.querySelector('[data-cbx-config]');
    if(!root?.cbxOpen)return;event.preventDefault();
    if(trigger.dataset.cbxEdit){root.cbxEdit(trigger.dataset.cbxEdit);return;}
    root.cbxOpen(trigger.dataset.cbxOpen,trigger.dataset.cbxStep!==undefined?Number(trigger.dataset.cbxStep):null,trigger,trigger.dataset.cbxFocus);
  });
  const requestedRoute=new URLSearchParams(location.search).get('cbx-open');
  if(['self','gift','curated'].includes(requestedRoute)){
    const root=document.querySelector('[data-cbx-config]');
    if(root?.cbxOpen){root.cbxOpen(requestedRoute,0,null);const url=new URL(location.href);url.searchParams.delete('cbx-open');history.replaceState(history.state,'',url.pathname+url.search+url.hash)}
  }
  const editId=new URLSearchParams(location.search).get('cbx-edit');
  if(editId){const root=document.querySelector('[data-cbx-config]');if(root?.cbxEdit)root.cbxEdit(editId);}
})();

