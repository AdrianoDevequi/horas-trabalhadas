# Time Tracker - Controle de Horas

Este é um aplicativo para Windows desenvolvido para rastrear automaticamente suas horas de trabalho diárias.

## Funcionalidades

- **Rastreamento Automático:** Monitora o tempo ativo no computador.
- **Detecção de Inatividade:** Pausa a contagem automaticamente após 2 minutos sem uso do mouse ou teclado.
- **Detecção do Chrome:** Verifica se o Google Chrome está aberto como parte da detecção de atividade.
- **Notificações:** Envia alertas do Windows ao atingir metas diárias (6h, 8h e 10h).
- **Inicialização Automática:** Opção para iniciar junto com o Windows.
- **Persistência:** Salva o histórico de horas trabalhadas diariamente.

## Como Usar (Desenvolvimento)

Para baixar e rodar este projeto em sua máquina:

1. **Clone o repositório:**
   ```bash
   git clone https://github.com/AdrianoDevequi/horas-trabalhadas.git
   ```

2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Rode o projeto:**
   ```bash
   npm start
   ```

4. **Gerar executável:**
   ```bash
   npm run build
   ```
   O executável será gerado na pasta `dist/`.

## Tecnologias

- Electron
- Node.js
- PowerShell (para detecção de ociosidade)
