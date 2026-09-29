# I-Bot MCP — Integra Sistema

Conecta o **WhatsApp do I-Bot** ao **Claude Code**, em modo **somente leitura**.
Depois de instalar, você pode pedir coisas como *"quais conversas estão sem resposta?"* ou *"lê as últimas mensagens do cliente 31 99999-0000"*.

> 🔒 **Somente leitura.** Este MCP **não envia mensagens**, não altera contatos, campos, nomes ou notas e não dispara fluxos. Ele só consulta.

## O que ele faz

| Tool | O que faz |
|---|---|
| `ibot_list_chats` | Lista conversas com filtros (status, não lidas, aparelho, arquivadas…) |
| `ibot_read_messages` | Lê o histórico de um chat (mensagens + anotações) |
| `ibot_download_media` | Baixa áudio, imagem e arquivo recebidos |
| `ibot_get_chat_link` / `ibot_batch_get_chat_links` | Busca o chat por telefone e devolve o link |
| `ibot_read_custom_fields` | Lê os campos personalizados do chat |
| `ibot_read_tags` | Lê as tags do chat |
| `ibot_get_chat_status` / `ibot_get_message_status` | Consulta o status de um chat ou de uma mensagem (API oficial) |

---

## ⚠️ Importante: a conta I-Bot tem 2 números

Hoje a conta I-Bot tem **dois números de WhatsApp conectados**, e **cada número tem o próprio Phone ID**.
**Configure os dois** (`IBOT_PHONE_ID` e `IBOT_PHONE_ID_2`). Com só um, o Claude avisa que falta o segundo.
Quando for pedir algo ao Claude, **diga de qual número está falando**. Assim ele não mistura conversas dos dois aparelhos.

---

## Passo a passo de instalação

### 1. Instale o que precisa (uma vez só)
- [Node.js 18 ou superior](https://nodejs.org/). Instale e **reinicie o computador**.
- [Git](https://git-scm.com/download/win)
- [Claude Code](https://claude.ai/download)

### 2. Pegue os dados no painel do I-Bot
Entre no painel (`https://s16.ibotzap.com.br`) com um usuário **administrador** e vá em **Configurações → API**. Anote:

| Dado | Onde fica | Variável |
|---|---|---|
| **API Key** (chave da API) | Configurações → API | `IBOT_API_KEY` |
| **Account ID** | Configurações → API | `IBOT_ACCOUNT_ID` |
| **Phone ID do número 1** | Configurações → API (lista de números/aparelhos) | `IBOT_PHONE_ID` |
| **Phone ID do número 2** | Mesma tela, o outro número | `IBOT_PHONE_ID_2` |
| **Servidor** | O número depois do "s" no endereço do painel (`s16` → `16`) | `IBOT_SERVER` (padrão `16`) |
| **Domínio** | `ibotzap.com.br` | `IBOT_DOMAIN` (padrão `ibotzap.com.br`) |

> Se não tiver acesso a essa tela, peça esses dados ao responsável pelo I-Bot na Integra.
> **Cuidado:** a API Key dá acesso ao WhatsApp da conta. Não poste em grupo e não coloque em nenhum arquivo do repositório.

### 3. Peça ao Claude Code para instalar
Abra o **Claude Code** e cole o texto abaixo:

```text
Instale o I-Bot MCP da Integra Sistema (https://github.com/SistemaIntegra/ibot-mcp).
Siga a seção "Roteiro de instalação (para o Claude)" do README de ponta a ponta.
Me peça os dados do I-Bot: API Key, Account ID, Phone ID do número 1 e Phone ID do número 2.
A conta tem DOIS números: configure os dois Phone IDs, não só um.
Regras: nunca me peça senha (o login no painel eu faço na janela do navegador);
nunca exiba minha API Key em resposta; só diga que terminou depois de testar de verdade.
```

### 4. Faça o login no painel
Uma janela de navegador vai abrir sozinha. Faça login no I-Bot normalmente. A sessão fica salva na sua máquina.
Depois **feche e abra o Claude Code** (o app inteiro).

### 5. Teste
Peça: *"Lista os 5 chats mais recentes do I-Bot, separando por número."* Se aparecerem os chats, está funcionando. 🎉

---

## Roteiro de instalação (para o Claude)

1. Confirme `node --version` ≥ 18 e `git --version`.
2. Clone e instale globalmente:
   ```bash
   git clone https://github.com/SistemaIntegra/ibot-mcp.git "%USERPROFILE%\ibot-mcp"
   cd "%USERPROFILE%\ibot-mcp" && npm install && npm install -g .
   npx playwright install chromium
   ```
3. Descubra o caminho do `index.js` global (`npm root -g` + `\ibot-mcp\index.js`).
4. Peça ao usuário **API Key, Account ID, Phone ID do número 1 e Phone ID do número 2**. São **dois** números, então insista no segundo.
5. Adicione em `~/.claude.json`, em `mcpServers`. Use `node` + caminho absoluto, **não** `npx`:
   ```json
   "ibot": {
     "type": "stdio",
     "command": "node",
     "args": ["<npm root -g>\\ibot-mcp\\index.js"],
     "env": {
       "IBOT_SERVER": "16",
       "IBOT_DOMAIN": "ibotzap.com.br",
       "IBOT_API_KEY": "<api key>",
       "IBOT_ACCOUNT_ID": "<account id>",
       "IBOT_PHONE_ID": "<phone id número 1>",
       "IBOT_PHONE_ID_2": "<phone id número 2>"
     }
   }
   ```
6. Rode `ibot-mcp login` (ou `node <caminho>\index.js login`). Abre um navegador e **o usuário** faz login. A sessão fica em `~/.ibot-mcp/session.json`.
7. Peça para o usuário reiniciar o Claude Code e valide chamando `ibot_list_chats` com `limit: 5`.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `IBOT_SERVER` | não (padrão `16`) | Número do servidor do painel |
| `IBOT_DOMAIN` | não (padrão `ibotzap.com.br`) | Domínio do painel |
| `IBOT_API_KEY` | para as tools de status | Chave da API |
| `IBOT_ACCOUNT_ID` | para as tools de status | ID da conta |
| `IBOT_PHONE_ID` | para as tools de status | Phone ID do número 1 |
| `IBOT_PHONE_ID_2` | recomendado | Phone ID do número 2 |
| `IBOT_DEVICE` | não | Fixa um aparelho padrão nas leituras (vazio = todos) |
| `IBOT_SESSION_PATH` | não | Caminho alternativo do arquivo de sessão |

A leitura das conversas usa só a sessão do painel. A API Key, o Account ID e os Phone IDs são usados pelas tools de status.

## Problemas comuns
- **"Sessão expirada":** rode `ibot-mcp login` de novo.
- **As tools não aparecem:** reinicie o Claude Code inteiro e confira o caminho do `index.js` em `~/.claude.json`.

---
Integra Sistema · Licença MIT (ver [LICENSE](LICENSE))
