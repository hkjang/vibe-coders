/**
 * vibe-coders Official Landing Page Interactive Script
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

      // Handle special tab anchors (#observability, #mcp, #features, #security)
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
