/**
 * vibe-coders Official Landing Page Interactive Script
 * Rich Marketing & Interactive Simulator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Mobile Nav Toggle & Close on Click
  const mobileToggle = document.getElementById('mobileToggle');
  const navMenu = document.getElementById('navMenu');
  const navLinks = document.querySelectorAll('.nav-link');

  if (mobileToggle && navMenu) {
    mobileToggle.addEventListener('click', () => {
      navMenu.classList.toggle('active');
    });

    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        navMenu.classList.remove('active');
      });
    });
  }

  // Copy Code Functionality
  window.copyCommand = function(elementId, textToCopy) {
    const text = textToCopy || document.getElementById(elementId)?.innerText;
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 명령어가 클립보드에 복사되었습니다!');
    }).catch(err => {
      console.error('Failed to copy: ', err);
    });
  };

  // Toast Notice Helper
  function showToast(message) {
    let toast = document.getElementById('toastNotice');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toastNotice';
      toast.className = 'toast-notice';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>${message}</span>`;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // Tab Switcher Logic
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  function activateTab(tabId) {
    const targetBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const targetContent = document.getElementById(tabId);

    if (targetBtn && targetContent) {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      targetBtn.classList.add('active');
      targetContent.classList.add('active');
    }
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      activateTab(target);
    });
  });

  // Nav Menu Anchor Smooth Scroll & Tab Synchronization
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href').substring(1);
      if (!targetId) return;

      let tabToActivate = null;
      if (targetId === 'observability') tabToActivate = 'tab-observability';
      if (targetId === 'mcp') tabToActivate = 'tab-mcp';
      if (targetId === 'security') tabToActivate = 'tab-security';
      if (targetId === 'features') tabToActivate = 'tab-proxy';

      if (tabToActivate) {
        e.preventDefault();
        activateTab(tabToActivate);
        const featuresSec = document.getElementById('features');
        if (featuresSec) {
          featuresSec.scrollIntoView({ behavior: 'smooth' });
        }
      } else {
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          e.preventDefault();
          targetElement.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });

  // Live Proxy Simulator Logic
  const simBtns = document.querySelectorAll('.sim-btn');
  const simTerminal = document.getElementById('simTerminal');

  const simScenarios = {
    roo: [
      '<span style="color:#818cf8">[SSE PROXY]</span> POST /v1/chat/completions HTTP/1.1 (Client: Roo Code | IP: 192.168.1.45)',
      '<span style="color:#34d399">[SECURITY]</span> Secret Inspection Passed. No hardcoded credentials detected.',
      '<span style="color:#38bdf8">[QUOTA CHECK]</span> User: dev_lee (Daily KRW Used: ₩4,200 / ₩50,000) -> APPROVED',
      '<span style="color:#a855f7">[STREAM FLUSH]</span> First Chunk Latency: 2.1ms (Ultra-Low SSE Instant Flush active)',
      '<span style="color:#34d399">[COMPLETED]</span> Model: gpt-4o | Tokens: Prompt 840, Completion 320 | Cost: ₩2.32 | Status: 200 OK'
    ],
    cursor: [
      '<span style="color:#818cf8">[SSE PROXY]</span> POST /v1/chat/completions HTTP/1.1 (Client: Cursor IDE | IP: 192.168.1.102)',
      '<span style="color:#34d399">[SECURITY]</span> Prompt Masking Active. File path masked to `[REDACTED_PATH]`',
      '<span style="color:#38bdf8">[QUOTA CHECK]</span> Team: frontend-devs (Monthly KRW Used: ₩120,500 / ₩500,000) -> APPROVED',
      '<span style="color:#a855f7">[STREAM FLUSH]</span> First Chunk Latency: 1.8ms | Total Stream Latency: 420ms',
      '<span style="color:#34d399">[COMPLETED]</span> Model: claude-3-5-sonnet | Tokens: Prompt 1,420, Completion 510 | Cost: ₩3.86'
    ],
    secret: [
      '<span style="color:#818cf8">[SSE PROXY]</span> POST /v1/chat/completions HTTP/1.1 (Client: Continue VSCode)',
      '<span style="color:#ef4444; font-weight:bold;">[SECRET FIREWALL BLOCK]</span> AWS Access Key detected in prompt line 42: `AKIAIOSFODNN7EXAMPLE`',
      '<span style="color:#ef4444;">[ACTION TAKEN]</span> Request automatically aborted! Secret Firewall triggered Policy #104.',
      '<span style="color:#f59e0b">[AUDIT STORE]</span> Logged to SQLite/Postgres Security Audit Ledger (User IP: 192.168.2.14)',
      '<span style="color:#ef4444;">[RESPONSE]</span> HTTP 403 Forbidden - "Security Policy Violation: AWS Secret Key Detected"'
    ],
    quota: [
      '<span style="color:#818cf8">[SSE PROXY]</span> POST /v1/chat/completions HTTP/1.1 (Client: Custom Python Script)',
      '<span style="color:#f59e0b">[QUOTA EXCEEDED]</span> User: intern_kim | Daily KRW Limit: ₩10,000 | Current: ₩10,005',
      '<span style="color:#ef4444;">[ACTION TAKEN]</span> Hard quota limit hit. Request blocked from sending to OpenAI.',
      '<span style="color:#38bdf8">[HEADER INJECTED]</span> Retry-After: 43200s | X-Quota-Limit-KRW: 10000 | X-Quota-Remaining: 0',
      '<span style="color:#ef4444;">[RESPONSE]</span> HTTP 429 Too Many Requests - "Daily KRW Quota Exceeded for Key vbe_demo_key"'
    ]
  };

  function runSimScenario(scenarioKey) {
    if (!simTerminal || !simScenarios[scenarioKey]) return;

    simTerminal.innerHTML = '<div style="color:#94a3b8">// Initializing vibe-coders Proxy Gateway Inspection...</div>';
    const lines = simScenarios[scenarioKey];

    lines.forEach((line, idx) => {
      setTimeout(() => {
        const lineDiv = document.createElement('div');
        lineDiv.style.marginBottom = '0.4rem';
        lineDiv.innerHTML = line;
        simTerminal.appendChild(lineDiv);
        simTerminal.scrollTop = simTerminal.scrollHeight;
      }, (idx + 1) * 300);
    });
  }

  simBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      simBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sim = btn.getAttribute('data-sim');
      runSimScenario(sim);
    });
  });

  // FAQ Accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');
    if (question) {
      question.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        faqItems.forEach(i => i.classList.remove('open'));

        if (!isOpen) {
          item.classList.add('open');
        }
      });
    }
  });

  // ROI & Quota Calculator Logic
  const devCountSlider = document.getElementById('devCount');
  const devCountVal = document.getElementById('devCountVal');
  const reqPerDaySlider = document.getElementById('reqPerDay');
  const reqPerDayVal = document.getElementById('reqPerDayVal');

  const calcMonthlyTokens = document.getElementById('calcMonthlyTokens');
  const calcMonthlyCost = document.getElementById('calcMonthlyCost');
  const calcSavings = document.getElementById('calcSavings');

  function updateCalculator() {
    if (!devCountSlider || !reqPerDaySlider) return;

    const devs = parseInt(devCountSlider.value, 10);
    const reqs = parseInt(reqPerDaySlider.value, 10);

    if (devCountVal) devCountVal.textContent = `${devs} 명`;
    if (reqPerDayVal) reqPerDayVal.textContent = `${reqs} 회`;

    const tokensPerReq = 4000;
    const workingDays = 22;
    const totalRequests = devs * reqs * workingDays;
    const totalTokens = totalRequests * tokensPerReq;

    const costPerMillionKRW = 2000;
    const estimatedCostKRW = Math.round((totalTokens / 1000000) * costPerMillionKRW);
    const estimatedSavingsKRW = Math.round(estimatedCostKRW * 0.30);

    if (calcMonthlyTokens) {
      calcMonthlyTokens.textContent = (totalTokens / 1000000).toFixed(1) + ' M Tokens';
    }
    if (calcMonthlyCost) {
      calcMonthlyCost.textContent = '₩' + estimatedCostKRW.toLocaleString();
    }
    if (calcSavings) {
      calcSavings.textContent = '₩' + estimatedSavingsKRW.toLocaleString() + ' / 월';
    }
  }

  if (devCountSlider && reqPerDaySlider) {
    devCountSlider.addEventListener('input', updateCalculator);
    reqPerDaySlider.addEventListener('input', updateCalculator);
    updateCalculator();
  }
});
