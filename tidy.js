/* 설명 글 정리: 문장마다 줄바꿈(…요. …다.) — 글자(텍스트) 노드만 바꿈 */
(function(){
  var SEL='.amt-note,.st-note,.mt-note,.jf p,.jf-foot,.jf-step span,.inf-note p,.inf-foot,.hint,.my-sync span,.sd-l2';
  var RE=/([요다음]\.|[요다]\)\.?)\s+(?=\S)/g;
  function tidy(el){
    if(el.getAttribute('data-tidy')==='1'&&el.getAttribute('data-tl')===String(el.textContent.length)) return;
    var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null), ns=[], n;
    while((n=w.nextNode())) ns.push(n);
    ns.forEach(function(t){
      var v=t.nodeValue; if(!RE.test(v)){ RE.lastIndex=0; return; } RE.lastIndex=0;
      var parts=v.split(RE), f=document.createDocumentFragment();       // split은 캡처 그룹도 끼워 줌
      for(var i=0;i<parts.length;i+=2){
        f.appendChild(document.createTextNode(parts[i]+(parts[i+1]||'')));
        if(i+2<parts.length) f.appendChild(document.createElement('br'));
      }
      t.parentNode.replaceChild(f,t);
    });
    el.setAttribute('data-tidy','1'); el.setAttribute('data-tl',String(el.textContent.length));
  }
  var busy=false;
  function run(){ if(busy) return; busy=true; try{ document.querySelectorAll(SEL).forEach(tidy); }catch(e){} busy=false; }
  function start(){ run(); try{ new MutationObserver(function(){ clearTimeout(start._t); start._t=setTimeout(run,60); }).observe(document.body,{childList:true,subtree:true,characterData:true}); }catch(e){} }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start); else start();
})();
