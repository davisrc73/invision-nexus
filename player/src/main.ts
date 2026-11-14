import App from './App.svelte';

const target = document.getElementById('app')!;
// Limpa o ecrã de boot-fallback assim que o bundle JS carrega na Box Android
target.innerHTML = '';

const app = new App({
  target,
});

export default app;
