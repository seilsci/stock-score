/* 오른쪽 아래 떠 있는 ▲(맨 위로) ▼(맨 아래로) 버튼 — 모든 화면 공통 */
(function(){
  var box=document.createElement('div'); box.id='fab-ud';
  box.innerHTML='<button type="button" aria-label="맨 위로" data-d="up">▲</button><button type="button" aria-label="맨 아래로" data-d="down">▼</button>';
  document.body.appendChild(box);
  var up=box.children[0], dn=box.children[1];
  function root(){ return document.documentElement; }
  function place(){
    var dock=document.getElementById('my-dock'), off=0;
    if(dock && dock.offsetParent!==null && getComputedStyle(dock).display!=='none') off=dock.offsetHeight;      // 하단 고정 '내 보유 종목' 창 위로 올림
    box.style.bottom=(14+off)+'px';
    var y=window.pageYOffset||0, max=root().scrollHeight-window.innerHeight;
    up.classList.toggle('off',y<40); dn.classList.toggle('off',y>max-40);
  }
  box.addEventListener('click',function(e){ var d=e.target.getAttribute&&e.target.getAttribute('data-d'); if(!d) return;
    window.scrollTo({top:d==='up'?0:root().scrollHeight,behavior:'smooth'}); });
  window.addEventListener('scroll',place,{passive:true}); window.addEventListener('resize',place);
  setInterval(place,800); place();
})();
