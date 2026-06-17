document.addEventListener('DOMContentLoaded', async () => {
  const user = await window.glass.getUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  document.getElementById('user-name').textContent = user.name || 'User';
  document.getElementById('user-email').textContent = user.email || '';

  const avatar = document.getElementById('user-avatar');
  const placeholder = document.getElementById('user-avatar-placeholder');

  if (user.picture) {
    avatar.src = user.picture;
    avatar.hidden = false;
    placeholder.hidden = true;
  } else {
    const initials = (user.name || 'U')
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    placeholder.textContent = initials;
  }

  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.panel');

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const target = item.dataset.panel;

      navItems.forEach((n) => n.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));

      item.classList.add('active');
      document.getElementById(`panel-${target}`).classList.add('active');
    });
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    window.glass.logout();
  });
});
