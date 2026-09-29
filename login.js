/**
 * Login no painel do I-Bot — salva a sessão (cookies) que as tools de leitura usam.
 *
 * Uso: ibot-mcp login
 *
 * Abre um navegador VISÍVEL na URL do painel. Você faz o login normalmente (com 2FA,
 * se a conta tiver). O script detecta quando a URL sai da tela de login e salva a
 * sessão em ~/.ibot-mcp/session.json (ou IBOT_SESSION_PATH).
 *
 * Senha nunca passa por aqui: quem digita é você, na janela do navegador.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { baseUrl, SESSION_PATH } from "./panel.js";

const SERVER = process.env.IBOT_SERVER || "16";

if (!SERVER) {
  console.error("ERRO: Defina IBOT_SERVER (o número do seu servidor I-Bot, ex.: 17).");
  console.error("Exemplo: ibot-mcp login");
  process.exit(1);
}

const LOGIN_URL = baseUrl(SERVER);

console.log(`\nAbrindo navegador em: ${LOGIN_URL}`);
console.log("Faça login normalmente. A sessão será salva sozinha depois do login.\n");

let browser;
try {
  browser = await chromium.launch({ headless: false });
} catch (err) {
  if (/Executable doesn't exist|browserType.launch/i.test(err.message)) {
    console.error("ERRO: o navegador do Playwright ainda não foi instalado nesta máquina.");
    console.error("Rode uma vez:  npx playwright install chromium\ne depois repita o login.");
    process.exit(1);
  }
  throw err;
}
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(LOGIN_URL);

console.log("Aguardando login (até 5 minutos)...");
try {
  await page.waitForURL((url) => {
    const path = url.pathname || "";
    return !path.includes("login") && !path.includes("signin") && path !== "/";
  }, { timeout: 300000 });
} catch {
  console.log("Tempo esgotado esperando a URL mudar. Salvando a sessão atual mesmo assim...");
}

// Um respiro pra cookies/localStorage assentarem
await new Promise((r) => setTimeout(r, 2000));

const storageState = await context.storageState();
await mkdir(dirname(SESSION_PATH), { recursive: true });
await writeFile(SESSION_PATH, JSON.stringify(storageState, null, 2));

console.log(`\nSessão salva em: ${SESSION_PATH}`);
console.log("Pode fechar. Reinicie o Claude Code pra ele passar a usar a sessão nova.");

await browser.close();
process.exit(0);
