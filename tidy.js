/* 설명 글 정리: 문장마다 줄바꿈(…요. …다.) — 글자(텍스트) 노드만 바꿈 */
(function(){
  var SEL='.amt-note,.st-note,.mt-note,.jf p,.jf-foot,.jf-step span,.inf-note p,.inf-foot,.hint,.my-sync span,.sd-l2,.sd-sum,.plan-note,.my-rec .amt-note';
  var RE=/([요다음]\.|[요다]\)\.?)\s+(?=\S)/g;
  function tidy(el){
    if(el.getAttribute('data-tidy')==='1'&&el.getAttribute('data-tl')===String(el.textContent.length)) return;
    var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null), ns=[], n;
    while((n=w.nextNode())) ns.push(n);
    ns.forEach(function(t){
      var v=t.nodeValue; if(v.length<22) return;
      var f=document.createDocumentFragment(), sents=v.split(RE), segs=[];
      for(var i=0;i<sents.length;i+=2) segs.push(sents[i]+(sents[i+1]||''));
      var lines=[];
      segs.forEach(function(sg){ pushLines(sg,lines); });
      lines.forEach(function(ln,i){ f.appendChild(document.createTextNode(ln)); if(i<lines.length-1) f.appendChild(document.createElement('br')); });
      t.parentNode.replaceChild(f,t);
    });
    el.setAttribute('data-tidy','1'); el.setAttribute('data-tl',String(el.textContent.length));
  }
  function pushLines(sg,out){                    // 긴 문장: 괄호 설명은 새 줄, 그래도 길면 쉼표 뒤에서 줄바꿈
    var m=sg.match(/^(.{8,}?)\s+(\(.{5,}\)\.?)$/);
    if(sg.length>34 && m){ pushLines(m[1],out); out.push(m[2]); return; }
    out.push(sg);
  }
  var busy=false;
  function run(){ if(busy) return; busy=true; try{ document.querySelectorAll(SEL).forEach(tidy); }catch(e){} busy=false; }
  function start(){ run(); try{ new MutationObserver(function(){ clearTimeout(start._t); start._t=setTimeout(run,60); }).observe(document.body,{childList:true,subtree:true,characterData:true}); }catch(e){} }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start); else start();
})();
