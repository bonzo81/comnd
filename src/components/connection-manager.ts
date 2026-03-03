/**
 * Connection Manager — home screen
 * Lists saved hosts. Add / edit / delete.
 */

export class ConnectionManager {
  private onConnect: (hostId: string) => void;

  constructor(onConnect: (hostId: string) => void) {
    this.onConnect = onConnect;
  }

  mount(container: HTMLElement) {
    container.innerHTML = `
      <div class="connection-manager">
        <div class="cm-header">
          <h1>net.sh</h1>
          <button class="btn-primary" id="new-host-btn">+ New Connection</button>
        </div>
        <div class="cm-search">
          <input type="text" placeholder="Search hosts... ( / )" id="host-search" />
        </div>
        <div class="cm-host-list" id="host-list">
          <div class="cm-empty-state">
            <div class="cm-empty-icon">🖥</div>
            <h2>Welcome to net.sh</h2>
            <p>A smarter SSH client for network engineers.<br/>
            Connect to your devices with context-aware command suggestions built in.</p>
            <button class="btn-primary" id="empty-add-btn">+ Add your first host</button>
            <p class="cm-platforms">Supports: Cisco IOS-XE · NX-OS · F5 TMOS · Linux</p>
            <p class="cm-tip">💡 After connecting, start typing a command and net.sh will suggest completions inline. Press Tab to accept, Ctrl+Space to browse.</p>
          </div>
        </div>
      </div>
    `;
  }
}
