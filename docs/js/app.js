/**
 * vibe-coders Official Landing Page Interactive Script
 */

document.addEventListener('DOMContentLoaded', () => {
  // Mobile Nav Toggle
  const mobileToggle = document.getElementById('mobileToggle');
  const navMenu = document.getElementById('navMenu');

  if (mobileToggle && navMenu) {
    mobileToggle.addEventListener('click', () => {
      navMenu.classList.toggle('active');
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

  // Tab Switcher
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');

      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const activeContent = document.getElementById(target);
      if (activeContent) {
        activeContent.classList.add('active');
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
        // Close all other items
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

    // Estimate math
    // Avg tokens per AI coding interaction (prompt + completion) ~ 4,000 tokens
    const tokensPerReq = 4000;
    const workingDays = 22;
    const totalRequests = devs * reqs * workingDays;
    const totalTokens = totalRequests * tokensPerReq;

    // Avg cost per 1M tokens ~ $1.50 -> ₩2,000 KRW
    const costPerMillionKRW = 2000;
    const estimatedCostKRW = Math.round((totalTokens / 1000000) * costPerMillionKRW);

    // vibe-coders caching, prompt optimization & quota prevention saves ~30%
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
