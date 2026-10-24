// S24 Ultra Pro Workout & Weight Tracker - Core Application Logic
(function () {
  const STORAGE_KEY = 's24_workout_tracker_data_v2';
  const THEME_KEY = 's24_workout_theme_v1';
  const GOAL_WEIGHT_KEY = 's24_workout_goal_weight_v1';

  // State
  let appData = null;
  let selectedDate = '2026-10-16';
  let activeTab = 'log'; // 'log' | 'stats' | 'calendar' | 'settings'
  let activeCategory = 'all'; // 'all' | 'lower' | 'upper' | 'cardio' | 'done'
  let activeStatsSubTab = 'weight'; // 'weight' | 'strength' | 'habit'
  let weightRange = 'ALL'; // '1M' | '3M' | '6M' | '1Y' | 'ALL'
  let selectedExerciseId = 'chest_press';
  let calendarYear = 2026;
  let calendarMonth = 10; // 1-12
  let heatmapYear = 2026;
  let editingExerciseId = null;
  let modalState = null;

  // Timer State
  let timerInterval = null;
  let timerSeconds = 0;
  let timerMode = 'rest'; // 'rest' | 'stopwatch'
  let timerRunning = false;
  let timerTarget = 60;

  // Goal weight
  let goalWeight = parseFloat(localStorage.getItem(GOAL_WEIGHT_KEY) || '80.0');

  // Initialize Data
  function loadData() {
    const savedV2 = localStorage.getItem(STORAGE_KEY);
    const savedV1 = localStorage.getItem('s24_workout_tracker_data_v1');
    const saved = savedV2 || savedV1;
    if (saved) {
      try {
        appData = JSON.parse(saved);
        // Also merge any dates recorded in V1 if both existed
        if (savedV2 && savedV1) {
          try {
            const v1Obj = JSON.parse(savedV1);
            if (v1Obj && v1Obj.days) {
              for (const [d, val] of Object.entries(v1Obj.days)) {
                if (!appData.days[d]) appData.days[d] = val;
              }
            }
          } catch (e) {}
        }
        // Always synchronize the 18 core exercises from seed (ensuring 무릎펴기(레그익스텐션) is present)
        if (window.INITIAL_WORKOUT_DATA) {
          const seedExercises = JSON.parse(JSON.stringify(window.INITIAL_WORKOUT_DATA.exercises));
          const seedIds = new Set(seedExercises.map((e) => e.id));
          // If user added a custom exercise for 레그프레스 / 다리로 밀기, migrate its logs into leg_press_machine
          const customLegPressIds = (appData.exercises || [])
            .filter((e) => !seedIds.has(e.id) && (e.name.includes('레그프레스') || e.name.includes('다리로 밀기')))
            .map((e) => e.id);
          if (customLegPressIds.length > 0 && appData.days) {
            for (const dayVal of Object.values(appData.days)) {
              if (dayVal && dayVal.r) {
                for (const cid of customLegPressIds) {
                  if (dayVal.r[cid] && !dayVal.r['leg_press_machine']) {
                    dayVal.r['leg_press_machine'] = dayVal.r[cid];
                  }
                }
              }
            }
          }
          const customExercises = (appData.exercises || []).filter(
            (e) =>
              !seedIds.has(e.id) &&
              e.id !== 'leg_curl' &&
              e.name !== '무릎 구부리기' &&
              !customLegPressIds.includes(e.id)
          );
          appData.exercises = [...seedExercises, ...customExercises];

          if (!appData.days) appData.days = {};
          const needLegPressTsvSync = !localStorage.getItem('s24_leg_press_tsv_applied_20261024c');
          for (const [d, val] of Object.entries(window.INITIAL_WORKOUT_DATA.days)) {
            if (!appData.days[d]) {
              appData.days[d] = JSON.parse(JSON.stringify(val));
            } else {
              if (!appData.days[d].r) appData.days[d].r = {};
              if (val.r) {
                for (const [exId, exRaw] of Object.entries(val.r)) {
                  if (!appData.days[d].r[exId]) {
                    appData.days[d].r[exId] = exRaw;
                  }
                }
              }
              if (needLegPressTsvSync) {
                if (val.r && val.r['leg_press_machine']) {
                  appData.days[d].r['leg_press_machine'] = val.r['leg_press_machine'];
                } else {
                  delete appData.days[d].r['leg_press_machine'];
                }
              }
              if (appData.days[d].w === null || appData.days[d].w === undefined) {
                appData.days[d].w = val.w;
              }
            }
          }
          if (needLegPressTsvSync) {
            localStorage.setItem('s24_leg_press_tsv_applied_20261024c', '1');
          }
        }
        saveData();
      } catch (e) {
        console.error('Failed to parse saved data, using seed', e);
        appData = JSON.parse(JSON.stringify(window.INITIAL_WORKOUT_DATA));
      }
    } else if (window.INITIAL_WORKOUT_DATA) {
      appData = JSON.parse(JSON.stringify(window.INITIAL_WORKOUT_DATA));
      saveData();
    } else {
      appData = { version: '1.0.0', defaultRepsPerSet: 10, exercises: [], days: {} };
    }

    // Determine initial date: today's local date if >= 2026-10-16, or latest recorded date
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    selectedDate = todayStr;
    calendarYear = yyyy;
    calendarMonth = now.getMonth() + 1;
    heatmapYear = yyyy;
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    } catch (e) {
      console.error('Failed to save data to localStorage', e);
    }
  }

  function vibrate(ms = 15) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) {}
    }
  }

  // Cell Parser (matches Python validation 100%)
  function parseWorkoutCell(rawVal, exType, exId = '') {
    if (!rawVal) return null;
    const s = String(rawVal).trim();
    if (!s) return null;

    if (s === '단백질보충') {
      return { status: 'tag', tag: '단백질보충', raw: s, display: '단백질보충' };
    }

    const painKeywords = ['통증', '감기', '병원', '진료', '한의원', '검진'];
    if (painKeywords.some((k) => s.includes(k))) {
      if (s.startsWith('X(') && s.endsWith(')')) {
        return { status: 'skip', note: s.slice(2, -1), raw: s, display: `미실시 (${s.slice(2, -1)})` };
      }
      return { status: 'pain', note: s, raw: s, display: s };
    }

    if (s === 'X' || s === '장비고장' || s === '장비수리' || s.startsWith('X(')) {
      const note = s.startsWith('X(') ? s.slice(2, -1) : (s !== 'X' ? s : '');
      return { status: 'skip', note, raw: s, display: note ? `X (${note})` : '미실시 (X)' };
    }

    const restKeywords = ['휴식', '여행', '출장', '연휴', '설날'];
    if (restKeywords.some((k) => s.includes(k))) {
      return { status: 'rest', note: s, raw: s, display: s };
    }

    if (exType === 'check') {
      if (s === 'O') return { status: 'done', sets: 1, raw: s, display: '완료 (O)' };
      if (s === '4가지') return { status: 'done', sets: 4, raw: s, display: '4가지 완료' };
      return { status: 'done', sets: 1, raw: s, display: s };
    }

    if (exType === 'stairs') {
      if (s === 'O') return { status: 'done', count: 1, sets: 1, raw: s, display: '완료 (O)' };
      const c = parseFloat(s);
      if (!isNaN(c)) {
        if (c === 0) return { status: 'skip', count: 0, raw: s, display: '0회' };
        return { status: 'done', count: c, sets: 1, raw: s, display: `${c}회 등반` };
      }
      return { status: 'done', count: 1, sets: 1, raw: s, display: s };
    }

    const inner = (s.startsWith('O(') && s.endsWith(')')) ? s.slice(2, -1).trim() : s;

    if (exType === 'time') {
      if (inner.includes('/')) {
        const parts = inner.split('/').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
        const totalSec = parts.reduce((a, b) => a + b, 0);
        const maxSec = parts.length ? Math.max(...parts) : 0;
        return {
          status: 'done',
          durations: parts,
          totalSec,
          maxSec,
          sets: parts.length,
          raw: s,
          display: `${parts.join('초 / ')}초 (총 ${totalSec}초)`
        };
      }
      const m = inner.match(/^(\d+)\s+(\d+)$/);
      if (m) {
        const sec = parseInt(m[1], 10);
        const cnt = parseInt(m[2], 10);
        const parts = Array(cnt).fill(sec);
        return {
          status: 'done',
          durations: parts,
          totalSec: sec * cnt,
          maxSec: sec,
          sets: cnt,
          raw: s,
          display: `${sec}초 × ${cnt}회 (총 ${sec * cnt}초)`
        };
      }
      const singleSec = parseInt(inner, 10);
      if (!isNaN(singleSec)) {
        return {
          status: 'done',
          durations: [singleSec],
          totalSec: singleSec,
          maxSec: singleSec,
          sets: 1,
          raw: s,
          display: `${singleSec}초 완료`
        };
      }
    }

    if (exType === 'reps') {
      if (inner.includes(',')) {
        const parts = inner.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
        const totalReps = parts.reduce((a, b) => a + b, 0);
        return {
          status: 'done',
          reps: parts.length ? Math.max(...parts) : 10,
          sets: parts.length,
          totalReps,
          raw: s,
          display: `${parts.join('/')}회 (총 ${totalReps}회)`
        };
      }
      const m = inner.match(/^(\d+)\s+(\d+)$/);
      if (m) {
        const rCnt = parseInt(m[1], 10);
        const sCnt = parseInt(m[2], 10);
        return {
          status: 'done',
          reps: rCnt,
          sets: sCnt,
          totalReps: rCnt * sCnt,
          raw: s,
          display: `${rCnt}회 × ${sCnt}세트`
        };
      }
    }

    // Weight Exercises
    if (s === 'O') {
      return { status: 'done', maxWeight: null, sets: 3, volume: 0, items: [], raw: s, display: '완료 (O)' };
    }

    if (inner.includes('무부하')) {
      const m = inner.match(/(\d+)/);
      const cnt = m ? parseInt(m[1], 10) : 5;
      return {
        status: 'done',
        maxWeight: 0,
        isBodyweight: true,
        sets: cnt,
        volume: 0,
        items: [{ w: 0, c: cnt, tag: '무부하' }],
        raw: s,
        display: `무부하(맨몸) ${cnt}회`
      };
    }

    if (inner.includes('Sets')) {
      const mw = inner.match(/(\d+)k/);
      const w = mw ? parseInt(mw[1], 10) : null;
      return {
        status: 'done',
        maxWeight: w,
        sets: 3,
        volume: w ? w * 3 * 10 : 0,
        items: [{ w: w || 0, c: 3, tag: '' }],
        raw: s,
        display: w ? `${w}kg · 3회` : '3세트 완료'
      };
    }

    if (inner === 'R 25 2 20 2') {
      return {
        status: 'done',
        maxWeight: 25,
        sets: 4,
        volume: (25 * 2 + 20 * 2) * 10,
        items: [{ w: 25, c: 2, tag: 'R' }, { w: 20, c: 2, tag: 'R' }],
        raw: s,
        display: 'R 25kg 2회, 20kg 2회'
      };
    }

    const items = [];
    const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
    for (let p of parts) {
      let tag = '';
      if (p.startsWith('R ')) { tag = 'R'; p = p.slice(2).trim(); }
      else if (p.startsWith('왼팔')) { tag = '왼팔'; p = p.slice(2).trim(); }
      else if (p.startsWith('왼')) { tag = '왼'; p = p.slice(1).trim(); }
      else if (p.startsWith('뒤')) { tag = '뒤'; p = p.slice(1).trim(); }
      else if (p.startsWith('앞')) { tag = '앞'; p = p.slice(1).trim(); }

      if (p.includes('/')) {
        const nums = (p.match(/\d+/g) || []).map((n) => parseInt(n, 10));
        nums.forEach((wVal) => items.push({ w: wVal, c: 1, tag }));
      } else {
        const nums = (p.match(/\d+/g) || []).map((n) => parseInt(n, 10));
        if (nums.length === 1) {
          items.push({ w: nums[0], c: 3, tag });
        } else if (nums.length >= 2) {
          const wVal = nums[0];
          const cVal = nums[1];
          if ((exId === 'hip_abduction' || exId === 'leg_press_machine') && cVal >= 20) {
            items.push({ w: wVal, c: Math.round(cVal / 10), reps: cVal, tag });
          } else {
            items.push({ w: wVal, c: cVal, tag });
          }
        }
      }
    }

    if (items.length > 0) {
      const maxWeight = Math.max(...items.map((i) => i.w));
      const sets = items.reduce((acc, i) => acc + i.c, 0);
      const volume = items.reduce((acc, i) => acc + i.w * i.c * 10, 0);
      const disp = items.map((i) => {
        const prefix = i.tag ? `${i.tag} ` : '';
        return i.reps ? `${prefix}${i.w}kg ${i.reps}회` : `${prefix}${i.w}kg ${i.c}회`;
      }).join(', ');
      return {
        status: 'done',
        maxWeight,
        sets,
        volume,
        items,
        raw: s,
        display: disp
      };
    }

    return { status: 'done', raw: s, display: s };
  }

  // Helper: Get latest done record for an exercise before or on date
  function getLatestPresetForExercise(exId, beforeDate = '9999-12-31') {
    const ex = appData.exercises.find((e) => e.id === exId);
    if (!ex) return 'O';
    const sortedDates = Object.keys(appData.days).sort();
    let latestRaw = null;
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      const d = sortedDates[i];
      if (d > beforeDate) continue;
      const raw = appData.days[d]?.r?.[exId];
      if (!raw) continue;
      const parsed = parseWorkoutCell(raw, ex.type, ex.id);
      if (parsed && parsed.status === 'done') {
        latestRaw = raw;
        break;
      }
    }
    if (latestRaw) return latestRaw;
    if (ex.type === 'check') return 'O';
    if (ex.type === 'stairs') return 'O';
    if (ex.type === 'time') return 'O(60)';
    if (ex.type === 'reps') return '10 3';
    return 'O(40 3)';
  }

  // Get top frequent done values for quick chips in modal
  function getFrequentRecordsForExercise(exId, limit = 5) {
    const ex = appData.exercises.find((e) => e.id === exId);
    if (!ex) return [];
    const counts = {};
    const sortedDates = Object.keys(appData.days).sort();
    // Weight recent records higher
    sortedDates.slice(-180).forEach((d) => {
      const raw = appData.days[d]?.r?.[exId];
      if (!raw) return;
      const p = parseWorkoutCell(raw, ex.type, ex.id);
      if (p && p.status === 'done') {
        counts[raw] = (counts[raw] || 0) + 1;
      }
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map((x) => x[0]);
  }

  // Get all-time PR for exercise
  function getExercisePR(exId) {
    const ex = appData.exercises.find((e) => e.id === exId);
    if (!ex) return null;
    let maxW = 0;
    let maxSec = 0;
    let doneDays = 0;
    let hasBodyweightDip = false;
    for (const d of Object.keys(appData.days)) {
      const raw = appData.days[d]?.r?.[exId];
      if (!raw) continue;
      const p = parseWorkoutCell(raw, ex.type, ex.id);
      if (p && p.status === 'done') {
        doneDays++;
        if (ex.type === 'weight') {
          if (p.isBodyweight) hasBodyweightDip = true;
          if (p.maxWeight !== null && p.maxWeight > maxW) maxW = p.maxWeight;
        } else if (ex.type === 'time' && p.totalSec > maxSec) {
          maxSec = p.totalSec;
        }
      }
    }
    return { maxW, maxSec, doneDays, hasBodyweightDip };
  }

  // Format Date Korean
  function formatKoreanDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const dow = days[dt.getDay()];
    return { y, m, d, dow, full: `${y}. ${String(m).padStart(2, '0')}. ${String(d).padStart(2, '0')} (${dow})` };
  }

  function shiftDate(dateStr, deltaDays) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + deltaDays);
    const ny = dt.getFullYear();
    const nm = String(dt.getMonth() + 1).padStart(2, '0');
    const nd = String(dt.getDate()).padStart(2, '0');
    return `${ny}-${nm}-${nd}`;
  }

  function ensureDayObject(dateStr) {
    if (!appData.days[dateStr]) {
      appData.days[dateStr] = { w: null, r: {}, t: [] };
    }
    if (!appData.days[dateStr].r) appData.days[dateStr].r = {};
    if (!appData.days[dateStr].t) appData.days[dateStr].t = [];
    return appData.days[dateStr];
  }

  // Weight helpers
  function getWeightContext(dateStr) {
    const sortedDates = Object.keys(appData.days)
      .filter((d) => appData.days[d]?.w !== null && appData.days[d]?.w !== undefined)
      .sort();

    const currentW = appData.days[dateStr]?.w ?? null;
    let prevW = null;
    let prevDate = null;
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      if (sortedDates[i] < dateStr) {
        prevW = appData.days[sortedDates[i]].w;
        prevDate = sortedDates[i];
        break;
      }
    }

    // 7-day moving average up to dateStr
    const recent7 = sortedDates.filter((d) => d <= dateStr).slice(-7).map((d) => appData.days[d].w);
    const avg7 = recent7.length ? (recent7.reduce((a, b) => a + b, 0) / recent7.length) : null;

    // Last 14 weights for mini sparkline
    const recent14 = sortedDates.filter((d) => d <= dateStr).slice(-14).map((d) => ({
      date: d,
      w: appData.days[d].w
    }));

    const allWeights = sortedDates.map((d) => appData.days[d].w);
    const maxW = allWeights.length ? Math.max(...allWeights) : 90.5;
    const minW = allWeights.length ? Math.min(...allWeights) : 77.2;

    return { currentW, prevW, prevDate, avg7, recent14, maxW, minW };
  }

  // Expose actions to window for inline event handlers
  window.AppActions = {
    setTab(tab) {
      vibrate(10);
      activeTab = tab;
      renderApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    setDate(newDate) {
      if (!newDate) return;
      vibrate(10);
      selectedDate = newDate;
      const [y, m] = newDate.split('-').map(Number);
      calendarYear = y;
      calendarMonth = m;
      renderApp();
    },
    shiftSelectedDate(delta) {
      vibrate(10);
      selectedDate = shiftDate(selectedDate, delta);
      renderApp();
    },
    goToday() {
      vibrate(15);
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      selectedDate = `${yyyy}-${mm}-${dd}`;
      renderApp();
    },
    adjustWeight(delta) {
      vibrate(12);
      const dayObj = ensureDayObject(selectedDate);
      const ctx = getWeightContext(selectedDate);
      const base = dayObj.w !== null && dayObj.w !== undefined ? dayObj.w : (ctx.prevW || 82.35);
      dayObj.w = Math.round((base + delta) * 100) / 100;
      saveData();
      renderApp();
    },
    saveWeightInput() {
      const inp = document.getElementById('direct-weight-input');
      if (!inp) return;
      const val = parseFloat(inp.value);
      const dayObj = ensureDayObject(selectedDate);
      if (isNaN(val) || val <= 20 || val >= 250) {
        dayObj.w = null;
      } else {
        dayObj.w = Math.round(val * 100) / 100;
      }
      vibrate(20);
      saveData();
      showToast(dayObj.w ? `${selectedDate} 몸무게 ${dayObj.w}kg 저장 완료!` : '몸무게 기록이 초기화되었습니다.');
      renderApp();
    },
    setCategory(cat) {
      vibrate(10);
      activeCategory = cat;
      renderApp();
    },
    quickToggleDone(exId) {
      vibrate(20);
      const dayObj = ensureDayObject(selectedDate);
      const ex = appData.exercises.find((e) => e.id === exId);
      if (!ex) return;
      const currentRaw = dayObj.r[exId];
      const parsed = currentRaw ? parseWorkoutCell(currentRaw, ex.type, ex.id) : null;

      if (parsed && parsed.status === 'done') {
        // Already done -> open modal to edit or clear
        window.AppActions.openExerciseModal(exId);
      } else {
        // Fill with latest preset immediately!
        const preset = getLatestPresetForExercise(exId, selectedDate);
        dayObj.r[exId] = preset;
        saveData();
        showToast(`${ex.shortName}: ${preset} 기록 완료!`);
        renderApp();
      }
    },
    quickSetRest(exId) {
      vibrate(12);
      const dayObj = ensureDayObject(selectedDate);
      if (dayObj.r[exId] === '휴식') {
        delete dayObj.r[exId];
      } else {
        dayObj.r[exId] = '휴식';
      }
      saveData();
      renderApp();
    },
    applyDayTag(tag) {
      vibrate(15);
      const dayObj = ensureDayObject(selectedDate);
      const idx = dayObj.t.indexOf(tag);
      if (idx >= 0) {
        dayObj.t.splice(idx, 1);
      } else {
        dayObj.t.push(tag);
      }
      // If batch rest tag clicked, offer to mark corresponding exercises as rest
      if (tag === '휴식' || tag === '하체 휴식' || tag === '상체 휴식') {
        appData.exercises.forEach((ex) => {
          if (ex.category === 'cardio' && ex.id !== 'hanging') return;
          if (tag === '하체 휴식' && ex.category !== 'lower') return;
          if (tag === '상체 휴식' && ex.category !== 'upper') return;
          if (!dayObj.r[ex.id]) {
            dayObj.r[ex.id] = tag;
          }
        });
        showToast(`미기록 운동에 '${tag}' 일괄 적용 완료!`);
      }
      saveData();
      renderApp();
    },
    openExerciseModal(exId) {
      vibrate(15);
      editingExerciseId = exId;
      const ex = appData.exercises.find((e) => e.id === exId);
      const dayObj = ensureDayObject(selectedDate);
      const currentRaw = dayObj.r[exId] || getLatestPresetForExercise(exId, selectedDate);
      const parsed = parseWorkoutCell(currentRaw, ex.type, ex.id);

      if (ex.type === 'weight') {
        let items = [{ w: 40, c: 3, tag: '' }];
        if (parsed && parsed.status === 'done' && parsed.items && parsed.items.length > 0) {
          items = JSON.parse(JSON.stringify(parsed.items));
        } else {
          const fallbackP = parseWorkoutCell(getLatestPresetForExercise(exId, selectedDate), ex.type, ex.id);
          if (fallbackP && fallbackP.items && fallbackP.items.length > 0) {
            items = JSON.parse(JSON.stringify(fallbackP.items));
          }
        }
        modalState = { type: 'weight', items, rawInput: dayObj.r[exId] || '' };
      } else if (ex.type === 'time') {
        let durations = [60];
        if (parsed && parsed.status === 'done' && parsed.durations) {
          durations = [...parsed.durations];
        } else {
          const fallbackP = parseWorkoutCell(getLatestPresetForExercise(exId, selectedDate), ex.type, ex.id);
          if (fallbackP && fallbackP.durations) durations = [...fallbackP.durations];
        }
        modalState = { type: 'time', durations };
      } else if (ex.type === 'reps') {
        let reps = 10, sets = 3;
        if (parsed && parsed.status === 'done') {
          reps = parsed.reps || 10;
          sets = parsed.sets || 3;
        }
        modalState = { type: 'reps', reps, sets };
      } else if (ex.type === 'stairs') {
        let count = 5;
        if (parsed && parsed.status === 'done' && parsed.count) count = parsed.count;
        modalState = { type: 'stairs', count };
      } else {
        modalState = { type: 'check' };
      }
      renderModal();
    },
    closeModal() {
      editingExerciseId = null;
      modalState = null;
      const el = document.getElementById('modal-container');
      if (el) el.innerHTML = '';
    },
    modalAdjustWeight(idx, delta) {
      vibrate(10);
      if (!modalState || !modalState.items[idx]) return;
      modalState.items[idx].w = Math.max(0, (modalState.items[idx].w || 0) + delta);
      if (modalState.items[idx].w > 0 && modalState.items[idx].tag === '무부하') {
        modalState.items[idx].tag = '';
      }
      renderModal();
    },
    modalAdjustSets(idx, delta) {
      vibrate(10);
      if (!modalState || !modalState.items[idx]) return;
      modalState.items[idx].c = Math.max(1, (modalState.items[idx].c || 1) + delta);
      renderModal();
    },
    modalToggleTag(idx, tagVal) {
      vibrate(10);
      if (!modalState || !modalState.items[idx]) return;
      if (modalState.items[idx].tag === tagVal) {
        modalState.items[idx].tag = '';
      } else {
        modalState.items[idx].tag = tagVal;
        if (tagVal === '무부하') modalState.items[idx].w = 0;
      }
      renderModal();
    },
    modalAddSetGroup() {
      vibrate(12);
      if (!modalState || !modalState.items) return;
      const last = modalState.items[modalState.items.length - 1] || { w: 40, c: 2, tag: '' };
      modalState.items.push({ w: last.w + 5, c: last.c, tag: last.tag });
      renderModal();
    },
    modalRemoveSetGroup(idx) {
      vibrate(12);
      if (!modalState || !modalState.items || modalState.items.length <= 1) return;
      modalState.items.splice(idx, 1);
      renderModal();
    },
    modalAdjustDuration(idx, delta) {
      vibrate(10);
      if (!modalState || !modalState.durations) return;
      modalState.durations[idx] = Math.max(5, modalState.durations[idx] + delta);
      renderModal();
    },
    modalAddDuration() {
      vibrate(12);
      if (!modalState || !modalState.durations) return;
      modalState.durations.push(20);
      renderModal();
    },
    modalRemoveDuration(idx) {
      vibrate(12);
      if (!modalState || !modalState.durations || modalState.durations.length <= 1) return;
      modalState.durations.splice(idx, 1);
      renderModal();
    },
    modalAdjustReps(field, delta) {
      vibrate(10);
      if (!modalState) return;
      modalState[field] = Math.max(1, (modalState[field] || 1) + delta);
      renderModal();
    },
    modalSaveStructured() {
      vibrate(20);
      if (!editingExerciseId || !modalState) return;
      const ex = appData.exercises.find((e) => e.id === editingExerciseId);
      const dayObj = ensureDayObject(selectedDate);
      let rawStr = 'O';

      if (modalState.type === 'weight') {
        const parts = modalState.items.map((it) => {
          if (it.tag === '무부하' || (ex.id === 'dipping' && it.w === 0)) {
            return `무부하 ${it.c}`;
          }
          const pfx = it.tag ? `${it.tag} ` : '';
          return `${pfx}${it.w} ${it.c}`;
        });
        rawStr = `O(${parts.join(', ')})`;
      } else if (modalState.type === 'time') {
        rawStr = `O(${modalState.durations.join('/')})`;
      } else if (modalState.type === 'reps') {
        rawStr = `${modalState.reps} ${modalState.sets}`;
      } else if (modalState.type === 'stairs') {
        rawStr = String(modalState.count);
      }

      dayObj.r[editingExerciseId] = rawStr;
      saveData();
      showToast(`${ex.shortName}: ${rawStr} 저장됨!`);
      window.AppActions.closeModal();
      renderApp();
    },
    modalSaveDirectString(rawStr) {
      vibrate(20);
      if (!editingExerciseId) return;
      const ex = appData.exercises.find((e) => e.id === editingExerciseId);
      const dayObj = ensureDayObject(selectedDate);
      if (!rawStr) {
        delete dayObj.r[editingExerciseId];
        showToast(`${ex.shortName} 기록 삭제됨`);
      } else {
        dayObj.r[editingExerciseId] = rawStr;
        showToast(`${ex.shortName}: ${rawStr} 저장됨!`);
      }
      saveData();
      window.AppActions.closeModal();
      renderApp();
    },

    // Timer & Stopwatch Actions
    startRestTimer(sec) {
      vibrate(20);
      clearInterval(timerInterval);
      timerMode = 'rest';
      timerTarget = sec;
      timerSeconds = sec;
      timerRunning = true;
      updateTimerUI();
      timerInterval = setInterval(() => {
        timerSeconds--;
        if (timerSeconds <= 0) {
          timerSeconds = 0;
          timerRunning = false;
          clearInterval(timerInterval);
          vibrate([200, 100, 200, 100, 300]);
          showToast('⏰ 휴식 시간 종료! 다음 세트를 시작하세요 💪');
        }
        updateTimerUI();
      }, 1000);
    },
    toggleStopwatch() {
      vibrate(15);
      if (timerRunning && timerMode === 'stopwatch') {
        timerRunning = false;
        clearInterval(timerInterval);
        updateTimerUI();
      } else {
        clearInterval(timerInterval);
        if (timerMode !== 'stopwatch') timerSeconds = 0;
        timerMode = 'stopwatch';
        timerRunning = true;
        updateTimerUI();
        timerInterval = setInterval(() => {
          timerSeconds++;
          updateTimerUI();
        }, 1000);
      }
    },
    resetTimer() {
      vibrate(10);
      clearInterval(timerInterval);
      timerRunning = false;
      timerSeconds = 0;
      updateTimerUI();
    },
    saveStopwatchToHanging() {
      if (timerSeconds < 5) {
        showToast('최소 5초 이상 측정 후 기록해주세요.');
        return;
      }
      vibrate(25);
      const secRounded = Math.round(timerSeconds / 5) * 5 || timerSeconds;
      const dayObj = ensureDayObject(selectedDate);
      const cur = dayObj.r['hanging'];
      const p = cur ? parseWorkoutCell(cur, 'time', 'hanging') : null;
      let durations = [secRounded];
      if (p && p.status === 'done' && p.durations) {
        durations = [...p.durations, secRounded];
      }
      dayObj.r['hanging'] = `O(${durations.join('/')})`;
      saveData();
      window.AppActions.resetTimer();
      showToast(`🐒 매달리기 ${dayObj.r['hanging']} 자동 기록 완료!`);
      renderApp();
    },

    // Stats Actions
    setStatsSubTab(sub) {
      vibrate(10);
      activeStatsSubTab = sub;
      renderApp();
    },
    setWeightRange(rng) {
      vibrate(10);
      weightRange = rng;
      renderApp();
    },
    setSelectedExercise(exId) {
      vibrate(10);
      selectedExerciseId = exId;
      renderApp();
    },
    updateGoalWeight() {
      const inp = document.getElementById('goal-weight-input');
      if (!inp) return;
      const v = parseFloat(inp.value);
      if (!isNaN(v) && v >= 40 && v <= 150) {
        goalWeight = v;
        localStorage.setItem(GOAL_WEIGHT_KEY, String(v));
        showToast(`목표 체중 ${v}kg 설정 완료!`);
        renderApp();
      }
    },

    // Calendar Actions
    shiftCalendarMonth(delta) {
      vibrate(10);
      calendarMonth += delta;
      if (calendarMonth > 12) { calendarMonth = 1; calendarYear++; }
      if (calendarMonth < 1) { calendarMonth = 12; calendarYear--; }
      renderApp();
    },
    selectCalendarDay(dateStr) {
      vibrate(12);
      selectedDate = dateStr;
      renderApp();
    },
    setHeatmapYear(yr) {
      vibrate(10);
      heatmapYear = yr;
      renderApp();
    },

    // Settings / Data Management Actions
    addNewExercise() {
      const nameEl = document.getElementById('new-ex-name');
      const partEl = document.getElementById('new-ex-part');
      const catEl = document.getElementById('new-ex-cat');
      const typeEl = document.getElementById('new-ex-type');
      const iconEl = document.getElementById('new-ex-icon');
      if (!nameEl || !nameEl.value.trim()) {
        showToast('운동 이름을 입력해주세요.');
        return;
      }
      const name = nameEl.value.trim();
      const id = 'custom_' + Date.now();
      appData.exercises.push({
        id,
        row: appData.exercises.length + 7,
        name,
        shortName: name.slice(0, 8),
        category: catEl ? catEl.value : 'upper',
        part: partEl && partEl.value.trim() ? partEl.value.trim() : '전신',
        type: typeEl ? typeEl.value : 'weight',
        icon: iconEl ? iconEl.value : '🏋️',
        unit: typeEl && typeEl.value === 'time' ? '초' : (typeEl && typeEl.value === 'reps' ? '회' : 'kg')
      });
      saveData();
      showToast(`'${name}' 종목이 추가되었습니다!`);
      renderApp();
    },
    exportCSV() {
      vibrate(20);
      const dates = Object.keys(appData.days).sort();
      const headers = ['날짜', '요일', '몸무게(kg)', '메모/컨디션', ...appData.exercises.map((e) => e.name)];
      const rows = [headers.join(',')];
      const dowNames = ['일', '월', '화', '수', '목', '금', '토'];
      for (const d of dates) {
        const info = appData.days[d];
        const [yy, mm, dd] = d.split('-').map(Number);
        const dow = dowNames[new Date(yy, mm - 1, dd).getDay()];
        const w = info.w !== null && info.w !== undefined ? info.w : '';
        const tags = (info.t || []).join('/');
        const cols = [
          d,
          dow,
          w,
          `"${tags.replace(/"/g, '""')}"`,
          ...appData.exercises.map((e) => {
            const v = info.r?.[e.id] || '';
            return v.includes(',') ? `"${v}"` : v;
          })
        ];
        rows.push(cols.join(','));
      }
      const csvContent = '\uFEFF' + rows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `운동일지_몸무게_${selectedDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('엑셀(CSV) 파일 다운로드가 시작되었습니다!');
    },
    exportJSON() {
      vibrate(20);
      const blob = new Blob([JSON.stringify(appData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `S24_운동일지_백업_${selectedDate}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('전체 데이터 백업(JSON) 완료!');
    },
    importJSON(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target.result);
          if (imported && imported.days) {
            appData = imported;
            saveData();
            showToast('백업 데이터가 성공적으로 복원되었습니다!');
            renderApp();
          } else {
            showToast('유효하지 않은 백업 파일입니다.');
          }
        } catch (err) {
          showToast('파일을 읽는 중 오류가 발생했습니다.');
        }
      };
      reader.readAsText(file);
    },
    resetToSeedData() {
      if (!confirm('초기 엑셀 데이터(2024.03~2026.10) 상태로 복구하시겠습니까?')) return;
      localStorage.removeItem(STORAGE_KEY);
      loadData();
      saveData();
      showToast('원본 엑셀 데이터로 초기화되었습니다.');
      renderApp();
    }
  };

  function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast-msg';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 300);
    }, 2200);
  }

  function updateTimerUI() {
    const bar = document.getElementById('timer-live-display');
    if (!bar) return;
    const mins = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
    const secs = String(timerSeconds % 60).padStart(2, '0');
    bar.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="timer-dot ${timerRunning ? 'active' : ''}"></span>
          <span class="font-bold text-xs text-emerald-400">${timerMode === 'rest' ? '휴식 타이머' : '매달리기 측정'}</span>
          <span class="font-mono text-lg font-extrabold tracking-wider text-white">${mins}:${secs}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <button onclick="AppActions.startRestTimer(60)" class="timer-chip">60초</button>
          <button onclick="AppActions.startRestTimer(90)" class="timer-chip">90초</button>
          <button onclick="AppActions.toggleStopwatch()" class="timer-chip ${timerMode === 'stopwatch' && timerRunning ? 'active-sw' : ''}">
            ${timerMode === 'stopwatch' && timerRunning ? '⏸ 정지' : '🐒 측정'}
          </button>
          ${timerMode === 'stopwatch' && timerSeconds >= 5 ? `<button onclick="AppActions.saveStopwatchToHanging()" class="timer-chip save-sw">기록반영</button>` : ''}
          ${timerSeconds > 0 ? `<button onclick="AppActions.resetTimer()" class="timer-chip reset">✕</button>` : ''}
        </div>
      </div>
    `;
  }

  // Render Modal for Exercise Set Editing
  function renderModal() {
    const container = document.getElementById('modal-container');
    if (!container) return;
    if (!editingExerciseId || !modalState) {
      container.innerHTML = '';
      return;
    }
    const ex = appData.exercises.find((e) => e.id === editingExerciseId);
    const pr = getExercisePR(editingExerciseId);
    const freqList = getFrequentRecordsForExercise(editingExerciseId, 6);
    const currentRaw = appData.days[selectedDate]?.r?.[editingExerciseId] || '';

    let bodyHTML = '';
    if (modalState.type === 'weight') {
      bodyHTML = `
        <div class="space-y-3 mb-4">
          ${modalState.items.map((it, idx) => `
            <div class="modal-set-box">
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-bold text-emerald-400">세트 그룹 #${idx + 1}</span>
                <div class="flex items-center gap-1">
                  ${ex.id === 'dipping' ? `
                    <button onclick="AppActions.modalToggleTag(${idx}, '무부하')" class="tag-chip ${it.tag === '무부하' ? 'selected' : ''}">무부하(맨몸)</button>
                  ` : ''}
                  ${(ex.id === 'front_fly' || ex.id === 'lat_pulldown') ? `
                    <button onclick="AppActions.modalToggleTag(${idx}, 'R')" class="tag-chip ${it.tag === 'R' ? 'selected' : ''}">R (리버스)</button>
                  ` : ''}
                  <button onclick="AppActions.modalToggleTag(${idx}, '왼팔')" class="tag-chip ${it.tag === '왼팔' ? 'selected' : ''}">왼팔</button>
                  ${modalState.items.length > 1 ? `
                    <button onclick="AppActions.modalRemoveSetGroup(${idx})" class="text-xs text-rose-400 px-2 py-0.5 rounded bg-rose-500/10">삭제</button>
                  ` : ''}
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2.5">
                <div class="stepper-card">
                  <div class="text-xs text-slate-400 mb-1">무게 (kg)</div>
                  <div class="flex items-center justify-between">
                    <button onclick="AppActions.modalAdjustWeight(${idx}, -5)" class="step-btn">-5</button>
                    <span class="text-xl font-black text-white">${it.tag === '무부하' ? '무부하' : `${it.w}<small class="text-xs font-normal text-slate-400">kg</small>`}</span>
                    <button onclick="AppActions.modalAdjustWeight(${idx}, 5)" class="step-btn">+5</button>
                  </div>
                </div>
                <div class="stepper-card">
                  <div class="text-xs text-slate-400 mb-1">횟수 / 세트 (세트당 10회)</div>
                  <div class="flex items-center justify-between">
                    <button onclick="AppActions.modalAdjustSets(${idx}, -1)" class="step-btn">-1</button>
                    <span class="text-xl font-black text-emerald-400">${it.c}<small class="text-xs font-normal text-slate-400">회</small></span>
                    <button onclick="AppActions.modalAdjustSets(${idx}, 1)" class="step-btn">+1</button>
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
          <button onclick="AppActions.modalAddSetGroup()" class="w-full py-2.5 rounded-xl border border-dashed border-slate-600 text-slate-300 text-sm font-semibold hover:border-emerald-500">
            + 다른 무게 세트 추가 (예: 35kg 2회, 40kg 3회)
          </button>
        </div>
      `;
    } else if (modalState.type === 'time') {
      const totalSec = modalState.durations.reduce((a, b) => a + b, 0);
      bodyHTML = `
        <div class="space-y-2.5 mb-4">
          <div class="text-xs text-slate-400 flex justify-between">
            <span>세트별 매달리기 시간 (초)</span>
            <span class="text-emerald-400 font-bold">총 ${totalSec}초 (${modalState.durations.length}회)</span>
          </div>
          ${modalState.durations.map((sec, idx) => `
            <div class="stepper-card flex items-center justify-between">
              <span class="text-sm font-bold text-slate-300">${idx + 1}회차</span>
              <div class="flex items-center gap-3">
                <button onclick="AppActions.modalAdjustDuration(${idx}, -5)" class="step-btn">-5초</button>
                <span class="text-xl font-black text-emerald-400 w-16 text-center">${sec}초</span>
                <button onclick="AppActions.modalAdjustDuration(${idx}, 5)" class="step-btn">+5초</button>
                ${modalState.durations.length > 1 ? `<button onclick="AppActions.modalRemoveDuration(${idx})" class="text-rose-400 text-sm px-1">✕</button>` : ''}
              </div>
            </div>
          `).join('')}
          <button onclick="AppActions.modalAddDuration()" class="w-full py-2.5 rounded-xl border border-dashed border-slate-600 text-slate-300 text-sm font-semibold">
            + 추가 세트 시간 넣기 (예: 60 / 20 / 20)
          </button>
        </div>
      `;
    } else if (modalState.type === 'reps') {
      bodyHTML = `
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div class="stepper-card">
            <div class="text-xs text-slate-400 mb-1">세트당 반복 (회)</div>
            <div class="flex items-center justify-between">
              <button onclick="AppActions.modalAdjustReps('reps', -1)" class="step-btn">-1</button>
              <span class="text-xl font-black text-white">${modalState.reps}회</span>
              <button onclick="AppActions.modalAdjustReps('reps', 1)" class="step-btn">+1</button>
            </div>
          </div>
          <div class="stepper-card">
            <div class="text-xs text-slate-400 mb-1">세트 수</div>
            <div class="flex items-center justify-between">
              <button onclick="AppActions.modalAdjustReps('sets', -1)" class="step-btn">-1</button>
              <span class="text-xl font-black text-emerald-400">${modalState.sets}세트</span>
              <button onclick="AppActions.modalAdjustReps('sets', 1)" class="step-btn">+1</button>
            </div>
          </div>
        </div>
      `;
    } else if (modalState.type === 'stairs') {
      bodyHTML = `
        <div class="stepper-card mb-4">
          <div class="text-xs text-slate-400 mb-1">계단 오르기 횟수 (또는 O 완료)</div>
          <div class="flex items-center justify-between">
            <button onclick="AppActions.modalAdjustReps('count', -1)" class="step-btn">-1</button>
            <span class="text-2xl font-black text-emerald-400">${modalState.count}회</span>
            <button onclick="AppActions.modalAdjustReps('count', 1)" class="step-btn">+1</button>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) AppActions.closeModal()">
        <div class="modal-sheet">
          <div class="w-12 h-1.5 bg-slate-600 rounded-full mx-auto mb-3"></div>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-3">
              <div class="ex-icon-box">${ex.icon}</div>
              <div>
                <h3 class="text-lg font-extrabold text-white leading-tight">${ex.name}</h3>
                <p class="text-xs text-slate-400">${ex.part} · 누적 ${pr.doneDays}일 수행 ${pr.maxW ? `· 최고 PR ${pr.maxW}kg` : ''}</p>
              </div>
            </div>
            <button onclick="AppActions.closeModal()" class="w-8 h-8 rounded-full bg-slate-800 text-slate-300 font-bold">✕</button>
          </div>

          ${bodyHTML}

          <button onclick="AppActions.modalSaveStructured()" class="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-base shadow-lg shadow-emerald-500/25 mb-4">
            ✓ 위 세트로 운동 완료 저장
          </button>

          ${freqList.length > 0 ? `
            <div class="mb-4">
              <div class="text-xs font-bold text-slate-400 mb-2">⚡ 내가 자주 기록한 세트 원탭 선택</div>
              <div class="flex flex-wrap gap-1.5">
                ${freqList.map((f) => `
                  <button onclick="AppActions.modalSaveDirectString('${f.replace(/'/g, "\\'")}')" class="freq-pill ${currentRaw === f ? 'active' : ''}">
                    ${f}
                  </button>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="mb-3">
            <div class="text-xs font-bold text-slate-400 mb-2">상태 빠르게 변경</div>
            <div class="grid grid-cols-4 gap-1.5">
              <button onclick="AppActions.modalSaveDirectString('O')" class="status-quick-btn done">O (단순완료)</button>
              <button onclick="AppActions.modalSaveDirectString('휴식')" class="status-quick-btn rest">휴식</button>
              <button onclick="AppActions.modalSaveDirectString('X')" class="status-quick-btn skip">X (미실시)</button>
              <button onclick="AppActions.modalSaveDirectString('무릎통증')" class="status-quick-btn pain">통증/주의</button>
            </div>
          </div>

          ${currentRaw ? `
            <button onclick="AppActions.modalSaveDirectString('')" class="w-full py-2 text-xs text-rose-400 font-semibold">
              이 날의 ${ex.shortName} 기록 비우기 (초기화)
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  // Render Tab 1: Today's Log
  function renderLogTab() {
    const dtInfo = formatKoreanDate(selectedDate);
    const dayObj = ensureDayObject(selectedDate);
    const wCtx = getWeightContext(selectedDate);

    const diffPrev = (wCtx.currentW !== null && wCtx.prevW !== null)
      ? Math.round((wCtx.currentW - wCtx.prevW) * 100) / 100
      : null;

    // Count today's completed exercises
    let doneCount = 0;
    let restCount = 0;
    let todayVolume = 0;
    appData.exercises.forEach((ex) => {
      const raw = dayObj.r[ex.id];
      if (!raw) return;
      const p = parseWorkoutCell(raw, ex.type, ex.id);
      if (p?.status === 'done') {
        doneCount++;
        if (p.volume) todayVolume += p.volume;
      } else if (p?.status === 'rest') {
        restCount++;
      }
    });

    const filteredExercises = appData.exercises.filter((ex) => {
      if (activeCategory === 'all') return true;
      if (activeCategory === 'done') {
        const p = parseWorkoutCell(dayObj.r[ex.id], ex.type, ex.id);
        return p && p.status === 'done';
      }
      return ex.category === activeCategory;
    });

    const quickTags = ['휴식', '하체 휴식', '상체 휴식', '단백질보충', '무릎통증', '허리통증', '감기', '출장', '여행'];

    // Sparkline SVG for last 14 weights
    let sparkSvg = '';
    if (wCtx.recent14.length >= 2) {
      const ws = wCtx.recent14.map((x) => x.w);
      const minS = Math.min(...ws) - 0.3;
      const maxS = Math.max(...ws) + 0.3;
      const pts = wCtx.recent14.map((pt, i) => {
        const x = 10 + (i / (wCtx.recent14.length - 1)) * 180;
        const y = 38 - ((pt.w - minS) / (maxS - minS || 1)) * 28;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      sparkSvg = `
        <svg viewBox="0 0 200 46" class="w-36 h-11 overflow-visible">
          <polyline fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${pts}" />
          ${wCtx.recent14.map((pt, i) => {
            if (i !== wCtx.recent14.length - 1 && i !== 0) return '';
            const x = 10 + (i / (wCtx.recent14.length - 1)) * 180;
            const y = 38 - ((pt.w - minS) / (maxS - minS || 1)) * 28;
            return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#34d399" />`;
          }).join('')}
        </svg>
      `;
    }

    return `
      <!-- Date Selector Bar -->
      <div class="card-glass p-3.5 mb-3.5">
        <div class="flex items-center justify-between">
          <button onclick="AppActions.shiftSelectedDate(-1)" class="nav-arrow-btn" aria-label="이전 날짜">‹</button>
          <div class="text-center flex-1">
            <div class="flex items-center justify-center gap-2">
              <input type="date" value="${selectedDate}" onchange="AppActions.setDate(this.value)" class="date-hidden-picker" id="date-picker-input" />
              <label for="date-picker-input" class="cursor-pointer flex items-center gap-1.5">
                <span class="text-lg font-black tracking-tight text-white">${dtInfo.full}</span>
                <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold">📅 달력</span>
              </label>
            </div>
            <div class="text-xs text-slate-400 mt-0.5">
              오늘 완료 <strong class="text-emerald-400">${doneCount}개 종목</strong> · 총 볼륨 <strong class="text-cyan-400">${todayVolume.toLocaleString()}kg</strong>
            </div>
          </div>
          <button onclick="AppActions.shiftSelectedDate(1)" class="nav-arrow-btn" aria-label="다음 날짜">›</button>
        </div>
      </div>

      <!-- Weight Input Card -->
      <div class="card-glass weight-hero-card p-4 mb-3.5">
        <div class="flex items-start justify-between mb-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold uppercase tracking-wider text-emerald-400">⚖️ DAILY BODY WEIGHT</span>
              ${diffPrev !== null ? `
                <span class="text-xs font-bold px-2 py-0.5 rounded-full ${diffPrev <= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">
                  직전 대비 ${diffPrev > 0 ? `+${diffPrev}` : diffPrev}kg
                </span>
              ` : ''}
            </div>
            <div class="flex items-baseline gap-2 mt-1">
              <input id="direct-weight-input" type="number" step="0.05"
                value="${wCtx.currentW !== null ? wCtx.currentW : (wCtx.prevW || 82.35)}"
                onchange="AppActions.saveWeightInput()"
                class="weight-big-input" />
              <span class="text-xl font-bold text-slate-400">kg</span>
              <button onclick="AppActions.saveWeightInput()" class="ml-1 px-3 py-1.5 rounded-xl bg-emerald-500 text-slate-950 font-extrabold text-xs shadow">
                저장
              </button>
            </div>
            <div class="text-xs text-slate-400 mt-1">
              ${wCtx.currentW === null ? `<span class="text-amber-300">미입력 (직전 ${wCtx.prevW}kg 표시중)</span> · ` : `<span class="text-emerald-400 font-semibold">✓ 기록됨</span> · `}
              7일 평균 <strong class="text-slate-200">${wCtx.avg7 ? wCtx.avg7.toFixed(2) : '-'}kg</strong> · 최고 90.5 / 최저 77.2
            </div>
          </div>
          <div class="flex flex-col items-end">
            ${sparkSvg}
            <span class="text-xs text-slate-400">최근 14회 추이</span>
          </div>
        </div>

        <!-- Quick Weight Steppers -->
        <div class="grid grid-cols-6 gap-1.5">
          <button onclick="AppActions.adjustWeight(-0.5)" class="w-step-btn">-0.5</button>
          <button onclick="AppActions.adjustWeight(-0.1)" class="w-step-btn">-0.1</button>
          <button onclick="AppActions.adjustWeight(-0.05)" class="w-step-btn">-0.05</button>
          <button onclick="AppActions.adjustWeight(0.05)" class="w-step-btn plus">+0.05</button>
          <button onclick="AppActions.adjustWeight(0.1)" class="w-step-btn plus">+0.1</button>
          <button onclick="AppActions.adjustWeight(0.5)" class="w-step-btn plus">+0.5</button>
        </div>
      </div>

      <!-- Pro Timer & Hanging Stopwatch Bar -->
      <div id="timer-live-display" class="card-glass px-3.5 py-2.5 mb-3.5"></div>

      <!-- Daily Condition / Schedule Quick Chips -->
      <div class="mb-3.5">
        <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
          <span class="text-xs font-bold text-slate-400 shrink-0 mr-1">일정·컨디션:</span>
          ${quickTags.map((t) => {
            const active = dayObj.t && dayObj.t.includes(t);
            return `<button onclick="AppActions.applyDayTag('${t}')" class="cond-chip ${active ? 'active' : ''}">${t}</button>`;
          }).join('')}
        </div>
      </div>

      <!-- Category Filter Tabs -->
      <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar mb-3">
        ${[
          { id: 'all', label: `전체 (${appData.exercises.length})` },
          { id: 'lower', label: `🦵 하체 (${appData.exercises.filter((e) => e.category === 'lower').length})` },
          { id: 'upper', label: `💪 상체 (${appData.exercises.filter((e) => e.category === 'upper').length})` },
          { id: 'cardio', label: `🏃 유산소·일상 (${appData.exercises.filter((e) => e.category === 'cardio').length})` },
          { id: 'done', label: `✓ 완료 (${doneCount})` }
        ].map((c) => `
          <button onclick="AppActions.setCategory('${c.id}')" class="cat-tab ${activeCategory === c.id ? 'active' : ''}">
            ${c.label}
          </button>
        `).join('')}
      </div>

      <!-- Exercise Cards List -->
      <div class="space-y-2.5 pb-6">
        ${filteredExercises.map((ex) => {
          const raw = dayObj.r[ex.id] || '';
          const parsed = raw ? parseWorkoutCell(raw, ex.type, ex.id) : null;
          const preset = getLatestPresetForExercise(ex.id, shiftDate(selectedDate, -1));
          const pr = getExercisePR(ex.id);
          const status = parsed ? parsed.status : 'none';

          let statusBadge = '';
          if (status === 'done') {
            statusBadge = `<div class="ex-result-badge done">${parsed.display || raw}</div>`;
          } else if (status === 'rest') {
            statusBadge = `<div class="ex-result-badge rest">🌙 ${parsed.display}</div>`;
          } else if (status === 'pain') {
            statusBadge = `<div class="ex-result-badge pain">⚠️ ${parsed.display}</div>`;
          } else if (status === 'skip') {
            statusBadge = `<div class="ex-result-badge skip">✕ ${parsed.display}</div>`;
          } else {
            statusBadge = `<div class="flex items-center gap-1.5"><span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 text-[11px] font-bold">미입력</span><span class="text-xs text-slate-400">직전: <span class="text-slate-300 font-semibold">${preset}</span></span></div>`;
          }

          return `
            <div class="ex-card ${status}">
              <div class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onclick="AppActions.openExerciseModal('${ex.id}')">
                <div class="ex-icon-big ${status === 'done' ? 'done' : ''}">
                  <span>${ex.icon}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="font-extrabold text-base text-white truncate">${ex.name}</span>
                    <span class="part-badge ${ex.category}">${ex.part}</span>
                    ${pr.maxW ? `<span class="pr-mini-badge">PR ${pr.maxW}kg</span>` : ''}
                  </div>
                  <div class="mt-1">
                    ${statusBadge}
                  </div>
                </div>
              </div>

              <!-- Big Action Buttons -->
              <div class="flex items-center gap-1.5 shrink-0 ml-2">
                ${status === 'done' ? `
                  <button onclick="AppActions.openExerciseModal('${ex.id}')" class="big-action-btn edit" title="세트 수정">
                    ✓ 완료·수정
                  </button>
                ` : `
                  <button onclick="AppActions.quickSetRest('${ex.id}')" class="big-action-btn rest-btn ${status === 'rest' ? 'active' : ''}" title="휴식 표시">
                    휴식
                  </button>
                  <button onclick="AppActions.quickToggleDone('${ex.id}')" class="big-action-btn o-btn" title="클릭 시 직전 세트로 완료 입력">
                    ○ 완료입력
                  </button>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Render Tab 2: Multi-Angle Statistics
  function renderStatsTab() {
    const allDates = Object.keys(appData.days).sort();
    const weightDates = allDates.filter((d) => appData.days[d]?.w !== null && appData.days[d]?.w !== undefined);
    const latestW = weightDates.length ? appData.days[weightDates[weightDates.length - 1]].w : 82.35;
    const startW = weightDates.length ? appData.days[weightDates[0]].w : 90.25;
    const allWVals = weightDates.map((d) => appData.days[d].w);
    const maxW = allWVals.length ? Math.max(...allWVals) : 90.5;
    const minW = allWVals.length ? Math.min(...allWVals) : 77.2;

    // Workout attendance count
    let workoutDaysCount = 0;
    let totalVolumeTons = 0;
    allDates.forEach((d) => {
      const r = appData.days[d]?.r || {};
      let anyDone = false;
      appData.exercises.forEach((ex) => {
        const p = parseWorkoutCell(r[ex.id], ex.type, ex.id);
        if (p && p.status === 'done') {
          anyDone = true;
          if (p.volume) totalVolumeTons += p.volume / 1000;
        }
      });
      if (anyDone) workoutDaysCount++;
    });

    let subContent = '';

    if (activeStatsSubTab === 'weight') {
      // Monthly weight summary table
      const monthlyMap = {};
      weightDates.forEach((d) => {
        const ym = d.slice(0, 7);
        if (!monthlyMap[ym]) monthlyMap[ym] = [];
        monthlyMap[ym].push(appData.days[d].w);
      });
      const monthsList = Object.keys(monthlyMap).sort().reverse();

      subContent = `
        <!-- Weight Range Filter -->
        <div class="card-glass p-4 mb-3.5">
          <div class="flex items-center justify-between mb-3">
            <div>
              <h3 class="text-base font-extrabold text-white">📈 몸무게 & 7일 이동평균 추이</h3>
              <p class="text-xs text-slate-400">얇은 선: 일별 체중 · 굵은 초록선: 7일 이동평균 · 점선: 목표(${goalWeight}kg)</p>
            </div>
          </div>
          <div class="flex gap-1.5 mb-3">
            ${[
              { id: '1M', label: '1개월' },
              { id: '3M', label: '3개월' },
              { id: '6M', label: '6개월' },
              { id: '1Y', label: '1년' },
              { id: 'ALL', label: '전체(24.03~)' }
            ].map((r) => `
              <button onclick="AppActions.setWeightRange('${r.id}')" class="range-btn ${weightRange === r.id ? 'active' : ''}">${r.label}</button>
            `).join('')}
          </div>
          <div class="chart-box">
            <canvas id="weightChartCanvas" height="230"></canvas>
          </div>
          <div class="flex items-center justify-between mt-3 pt-3 border-t border-slate-800 text-xs">
            <div class="flex items-center gap-2">
              <span class="text-slate-400">🎯 목표 체중 설정:</span>
              <input id="goal-weight-input" type="number" step="0.5" value="${goalWeight}" class="w-16 px-2 py-1 rounded bg-slate-800 text-white font-bold text-center" />
              <span class="text-slate-400">kg</span>
            </div>
            <button onclick="AppActions.updateGoalWeight()" class="px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 font-bold">적용</button>
          </div>
        </div>

        <!-- Monthly Weight Breakdown -->
        <div class="card-glass p-4 mb-6">
          <h3 class="text-base font-extrabold text-white mb-3">🗓️ 월별 평균·최저·최고 몸무게 리포트 (${monthsList.length}개월)</h3>
          <div class="space-y-2 max-h-96 overflow-y-auto pr-1">
            ${monthsList.map((ym) => {
              const arr = monthlyMap[ym];
              const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
              const mn = Math.min(...arr);
              const mx = Math.max(...arr);
              const leftPct = Math.max(0, Math.min(100, ((mn - 76) / (91 - 76)) * 100));
              const widthPct = Math.max(4, Math.min(100 - leftPct, ((mx - mn) / (91 - 76)) * 100));
              return `
                <div class="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800/80">
                  <div class="flex items-center justify-between text-xs mb-1.5">
                    <span class="font-extrabold text-slate-200">${ym} <small class="text-slate-400 font-normal">(${arr.length}일)</small></span>
                    <div class="flex items-center gap-3">
                      <span class="text-cyan-400">최저 <b>${mn.toFixed(2)}</b></span>
                      <span class="text-emerald-400 text-sm">평균 <b>${avg.toFixed(2)}kg</b></span>
                      <span class="text-amber-400">최고 <b>${mx.toFixed(2)}</b></span>
                    </div>
                  </div>
                  <div class="w-full h-2 rounded-full bg-slate-800 relative overflow-hidden">
                    <div class="h-full rounded-full bg-gradient-to-r from-cyan-400 via-emerald-400 to-amber-400" style="margin-left:${leftPct.toFixed(1)}%; width:${widthPct.toFixed(1)}%"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else if (activeStatsSubTab === 'strength') {
      const selEx = appData.exercises.find((e) => e.id === selectedExerciseId) || appData.exercises[12];
      const pr = getExercisePR(selEx.id);
      const est1RM = pr.maxW ? Math.round(pr.maxW * (1 + 10 / 30)) : 0;

      subContent = `
        <!-- Exercise Selector Pills -->
        <div class="card-glass p-3.5 mb-3.5">
          <div class="text-xs font-bold text-slate-400 mb-2">운동 종목 선택 (클릭 시 상세 성장 그래프 표시)</div>
          <div class="flex flex-wrap gap-1.5">
            ${appData.exercises.map((ex) => `
              <button onclick="AppActions.setSelectedExercise('${ex.id}')" class="ex-select-pill ${selEx.id === ex.id ? 'active' : ''}">
                <span>${ex.icon}</span>
                <span>${ex.shortName}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <!-- Selected Exercise Growth Chart -->
        <div class="card-glass p-4 mb-3.5">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2.5">
              <div class="ex-icon-box">${selEx.icon}</div>
              <div>
                <h3 class="text-base font-extrabold text-white">${selEx.name}</h3>
                <p class="text-xs text-slate-400">${selEx.part} · 총 ${pr.doneDays}회(일) 수행</p>
              </div>
            </div>
            <div class="text-right">
              ${selEx.type === 'weight' ? `
                <div class="text-xs text-slate-400">최고 중량 / 추정 1RM</div>
                <div class="text-base font-black text-emerald-400">${selEx.id === 'dipping' && pr.hasBodyweightDip ? '무부하(맨몸) 성공!' : `${pr.maxW}kg`} <span class="text-xs text-cyan-400 font-bold">${est1RM ? `(1RM ~${est1RM}kg)` : ''}</span></div>
              ` : selEx.type === 'time' ? `
                <div class="text-xs text-slate-400">1일 최장 시간</div>
                <div class="text-base font-black text-emerald-400">총 ${pr.maxSec}초</div>
              ` : ''}
            </div>
          </div>
          <div class="chart-box">
            <canvas id="strengthChartCanvas" height="220"></canvas>
          </div>
        </div>

        <!-- All 19 Exercises PR & Progression Table -->
        <div class="card-glass p-4 mb-6">
          <h3 class="text-base font-extrabold text-white mb-3">🏆 18개 전 종목 누적 수행일 & 최고 기록(PR) 요약</h3>
          <div class="space-y-2">
            ${appData.exercises.map((ex) => {
              const pInfo = getExercisePR(ex.id);
              const latestPreset = getLatestPresetForExercise(ex.id);
              return `
                <div onclick="AppActions.setSelectedExercise('${ex.id}')" class="p-2.5 rounded-xl bg-slate-900/75 border ${selEx.id === ex.id ? 'border-emerald-500/60' : 'border-slate-800'} flex items-center justify-between cursor-pointer">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <span class="text-xl">${ex.icon}</span>
                    <div class="min-w-0">
                      <div class="text-sm font-bold text-white truncate">${ex.name}</div>
                      <div class="text-xs text-slate-400">${ex.part} · 최근 <b class="text-slate-200">${latestPreset}</b></div>
                    </div>
                  </div>
                  <div class="text-right shrink-0 ml-2">
                    <div class="text-sm font-extrabold text-emerald-400">
                      ${ex.id === 'dipping' && pInfo.hasBodyweightDip ? '무부하 달성' : (pInfo.maxW ? `PR ${pInfo.maxW}kg` : (pInfo.maxSec ? `최고 ${pInfo.maxSec}초` : '꾸준함'))}
                    </div>
                    <div class="text-xs text-slate-400">총 ${pInfo.doneDays}일 수행</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      // Habit, Body Part Balance & Injury/Condition History
      let lowerCount = 0, upperCount = 0, cardioCount = 0;
      const dowCounts = [0, 0, 0, 0, 0, 0, 0];
      const dowTotals = [0, 0, 0, 0, 0, 0, 0];
      const condCounts = { '무릎통증': 0, '허리통증': 0, '감기': 0, '여행/출장': 0, '단백질보충': 0 };

      allDates.forEach((d) => {
        const [yy, mm, dd] = d.split('-').map(Number);
        const dow = new Date(yy, mm - 1, dd).getDay();
        dowTotals[dow]++;
        const r = appData.days[d]?.r || {};
        const t = appData.days[d]?.t || [];
        let activeDay = false;

        if (t.some((x) => x.includes('무릎통증')) || Object.values(r).some((v) => v.includes('무릎통증'))) condCounts['무릎통증']++;
        if (t.some((x) => x.includes('허리통증')) || Object.values(r).some((v) => v.includes('허리통증'))) condCounts['허리통증']++;
        if (t.some((x) => x.includes('감기')) || Object.values(r).some((v) => v.includes('감기'))) condCounts['감기']++;
        if (t.some((x) => x.includes('여행') || x.includes('출장')) || Object.values(r).some((v) => v.includes('여행') || v.includes('출장'))) condCounts['여행/출장']++;
        if (t.includes('단백질보충')) condCounts['단백질보충']++;

        appData.exercises.forEach((ex) => {
          const p = parseWorkoutCell(r[ex.id], ex.type, ex.id);
          if (p && p.status === 'done') {
            activeDay = true;
            if (ex.category === 'lower') lowerCount++;
            else if (ex.category === 'upper') upperCount++;
            else cardioCount++;
          }
        });
        if (activeDay) dowCounts[dow]++;
      });

      const totalExecs = lowerCount + upperCount + cardioCount || 1;
      const dowNames = ['일', '월', '화', '수', '목', '금', '토'];

      subContent = `
        <!-- Body Part Balance -->
        <div class="card-glass p-4 mb-3.5">
          <h3 class="text-base font-extrabold text-white mb-2">⚖️ 신체 부위별 운동 밸런스 (총 ${totalExecs.toLocaleString()}회 종목 수행)</h3>
          <div class="w-full h-4 rounded-full overflow-hidden flex mb-3">
            <div style="width:${((lowerCount / totalExecs) * 100).toFixed(1)}%" class="bg-emerald-500"></div>
            <div style="width:${((upperCount / totalExecs) * 100).toFixed(1)}%" class="bg-cyan-500"></div>
            <div style="width:${((cardioCount / totalExecs) * 100).toFixed(1)}%" class="bg-amber-500"></div>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <div class="text-xs text-emerald-300 font-bold">🦵 하체 6종</div>
              <div class="text-lg font-black text-white">${((lowerCount / totalExecs) * 100).toFixed(1)}%</div>
              <div class="text-xs text-slate-400">${lowerCount.toLocaleString()}회</div>
            </div>
            <div class="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30">
              <div class="text-xs text-cyan-300 font-bold">💪 상체 8종</div>
              <div class="text-lg font-black text-white">${((upperCount / totalExecs) * 100).toFixed(1)}%</div>
              <div class="text-xs text-slate-400">${upperCount.toLocaleString()}회</div>
            </div>
            <div class="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <div class="text-xs text-amber-300 font-bold">🏃 유산소·코어</div>
              <div class="text-lg font-black text-white">${((cardioCount / totalExecs) * 100).toFixed(1)}%</div>
              <div class="text-xs text-slate-400">${cardioCount.toLocaleString()}회</div>
            </div>
          </div>
        </div>

        <!-- Day of Week Attendance Pattern -->
        <div class="card-glass p-4 mb-3.5">
          <h3 class="text-base font-extrabold text-white mb-3">📊 요일별 운동 출석 확률 패턴</h3>
          <div class="grid grid-cols-7 gap-1.5 text-center">
            ${[1, 2, 3, 4, 5, 6, 0].map((dIdx) => {
              const pct = dowTotals[dIdx] ? Math.round((dowCounts[dIdx] / dowTotals[dIdx]) * 100) : 0;
              return `
                <div class="p-2 rounded-xl bg-slate-900 border border-slate-800 flex flex-col items-center">
                  <span class="text-xs font-bold text-slate-300 mb-2">${dowNames[dIdx]}</span>
                  <div class="w-5 h-24 bg-slate-800 rounded-full flex items-end overflow-hidden p-0.5">
                    <div class="w-full rounded-full bg-gradient-to-t from-emerald-600 to-emerald-400" style="height:${pct}%"></div>
                  </div>
                  <span class="text-xs font-extrabold text-emerald-400 mt-1.5">${pct}%</span>
                  <span class="text-xs text-slate-400">${dowCounts[dIdx]}일</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Monthly Workout Attendance Chart -->
        <div class="card-glass p-4 mb-3.5">
          <h3 class="text-base font-extrabold text-white mb-2">🗓️ 월별 운동 수행 일수 추이 (24.03 ~ 26.10)</h3>
          <div class="chart-box">
            <canvas id="monthlyHabitCanvas" height="190"></canvas>
          </div>
        </div>

        <!-- Health & Condition Summary -->
        <div class="card-glass p-4 mb-6">
          <h3 class="text-base font-extrabold text-white mb-2.5">🩺 컨디션 · 통증 · 일정 누적 기록 분석</h3>
          <div class="grid grid-cols-2 gap-2">
            <div class="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30">
              <div class="text-xs text-rose-300 font-bold">⚠️ 무릎통증 기록일</div>
              <div class="text-xl font-black text-white mt-0.5">${condCounts['무릎통증']}일</div>
              <div class="text-xs text-slate-400">레그컬 휴식 및 중량 조절 케어</div>
            </div>
            <div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <div class="text-xs text-amber-300 font-bold">⚡ 허리통증 / 감기</div>
              <div class="text-xl font-black text-white mt-0.5">${condCounts['허리통증']}일 / ${condCounts['감기']}일</div>
              <div class="text-xs text-slate-400">컨디션 회복 후 루틴 복귀</div>
            </div>
            <div class="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30">
              <div class="text-xs text-cyan-300 font-bold">✈️ 여행 · 출장 일수</div>
              <div class="text-xl font-black text-white mt-0.5">${condCounts['여행/출장']}일</div>
              <div class="text-xs text-slate-400">유럽·일본·마카오·제주·출장</div>
            </div>
            <div class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
              <div class="text-xs text-emerald-300 font-bold">💪 총 운동 출석률</div>
              <div class="text-xl font-black text-white mt-0.5">${Math.round((workoutDaysCount / allDates.length) * 100)}%</div>
              <div class="text-xs text-slate-400">${allDates.length}일 중 ${workoutDaysCount}일 운동 수행</div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <!-- Top KPI Summary Cards -->
      <div class="grid grid-cols-3 gap-2 mb-3.5">
        <div class="card-glass p-3 text-center">
          <div class="text-xs text-slate-400">최고 대비 감량</div>
          <div class="text-lg font-black text-emerald-400">${(latestW - maxW).toFixed(2)}kg</div>
          <div class="text-xs text-slate-400">${maxW} → ${latestW}kg</div>
        </div>
        <div class="card-glass p-3 text-center">
          <div class="text-xs text-slate-400">총 운동 수행일</div>
          <div class="text-lg font-black text-cyan-400">${workoutDaysCount}일</div>
          <div class="text-xs text-slate-400">총 ${allDates.length}일 기록</div>
        </div>
        <div class="card-glass p-3 text-center">
          <div class="text-xs text-slate-400">누적 웨이트 볼륨</div>
          <div class="text-lg font-black text-amber-400">${Math.round(totalVolumeTons).toLocaleString()}톤</div>
          <div class="text-xs text-slate-400">세트당 10회 기준</div>
        </div>
      </div>

      <!-- Sub-navigation for Stats -->
      <div class="grid grid-cols-3 gap-1.5 p-1 rounded-2xl bg-slate-900/90 border border-slate-800 mb-3.5">
        <button onclick="AppActions.setStatsSubTab('weight')" class="subtab-btn ${activeStatsSubTab === 'weight' ? 'active' : ''}">⚖️ 체중 추이</button>
        <button onclick="AppActions.setStatsSubTab('strength')" class="subtab-btn ${activeStatsSubTab === 'strength' ? 'active' : ''}">🏋️ 종목별 성장</button>
        <button onclick="AppActions.setStatsSubTab('habit')" class="subtab-btn ${activeStatsSubTab === 'habit' ? 'active' : ''}">📊 부위·습관</button>
      </div>

      ${subContent}
    `;
  }

  // Render Tab 3: Calendar & Heatmap
  function renderCalendarTab() {
    const firstDay = new Date(calendarYear, calendarMonth - 1, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth, 0).getDate();
    const ymPrefix = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}`;

    const cells = [];
    for (let i = 0; i < firstDay; i++) cells.push('');
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${ymPrefix}-${String(d).padStart(2, '0')}`);
    }

    // Selected day detail
    const selInfo = appData.days[selectedDate] || { w: null, r: {}, t: [] };
    const dtFormatted = formatKoreanDate(selectedDate);
    const doneExercisesOnSelected = [];
    const otherExercisesOnSelected = [];

    appData.exercises.forEach((ex) => {
      const raw = selInfo.r?.[ex.id];
      if (!raw) return;
      const p = parseWorkoutCell(raw, ex.type, ex.id);
      if (p?.status === 'done') {
        doneExercisesOnSelected.push({ ex, raw, p });
      } else {
        otherExercisesOnSelected.push({ ex, raw, p });
      }
    });

    // Calculate monthly summary for current calendarMonth
    let mWorkoutDays = 0;
    const mWeights = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${ymPrefix}-${String(d).padStart(2, '0')}`;
      const inf = appData.days[ds];
      if (!inf) continue;
      if (inf.w) mWeights.push(inf.w);
      const hasDone = appData.exercises.some((ex) => {
        const p = parseWorkoutCell(inf.r?.[ex.id], ex.type, ex.id);
        return p && p.status === 'done';
      });
      if (hasDone) mWorkoutDays++;
    }
    const mAvgW = mWeights.length ? (mWeights.reduce((a, b) => a + b, 0) / mWeights.length).toFixed(2) : '-';

    return `
      <!-- Monthly Calendar Card -->
      <div class="card-glass p-4 mb-3.5">
        <div class="flex items-center justify-between mb-3">
          <button onclick="AppActions.shiftCalendarMonth(-1)" class="nav-arrow-btn">‹</button>
          <div class="text-center">
            <h3 class="text-lg font-black text-white">${calendarYear}년 ${calendarMonth}월</h3>
            <p class="text-xs text-slate-400">운동 <b class="text-emerald-400">${mWorkoutDays}일</b> · 월평균 체중 <b class="text-cyan-400">${mAvgW}kg</b></p>
          </div>
          <button onclick="AppActions.shiftCalendarMonth(1)" class="nav-arrow-btn">›</button>
        </div>

        <div class="grid grid-cols-7 gap-1 text-center text-xs font-bold text-slate-400 mb-1.5">
          <span class="text-rose-400">일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span class="text-cyan-400">토</span>
        </div>

        <div class="grid grid-cols-7 gap-1">
          ${cells.map((dateStr) => {
            if (!dateStr) return `<div class="h-14"></div>`;
            const dayNum = parseInt(dateStr.slice(-2), 10);
            const info = appData.days[dateStr];
            const isSel = dateStr === selectedDate;
            let hasLower = false, hasUpper = false, hasCardio = false, hasPain = false;

            if (info?.r) {
              appData.exercises.forEach((ex) => {
                const p = parseWorkoutCell(info.r[ex.id], ex.type, ex.id);
                if (p?.status === 'done') {
                  if (ex.category === 'lower') hasLower = true;
                  else if (ex.category === 'upper') hasUpper = true;
                  else hasCardio = true;
                } else if (p?.status === 'pain') {
                  hasPain = true;
                }
              });
            }
            const hasWorkout = hasLower || hasUpper || hasCardio;

            return `
              <button onclick="AppActions.selectCalendarDay('${dateStr}')"
                class="cal-cell ${isSel ? 'selected' : ''} ${hasWorkout ? 'has-workout' : ''}">
                <span class="text-xs font-extrabold ${isSel ? 'text-emerald-300' : 'text-slate-200'}">${dayNum}</span>
                ${info?.w ? `<span class="cal-weight">${info.w.toFixed(1)}</span>` : `<span class="cal-weight empty">-</span>`}
                <div class="flex items-center justify-center gap-0.5 mt-0.5">
                  ${hasLower ? `<span class="dot lower" title="하체"></span>` : ''}
                  ${hasUpper ? `<span class="dot upper" title="상체"></span>` : ''}
                  ${hasCardio ? `<span class="dot cardio" title="유산소"></span>` : ''}
                  ${hasPain ? `<span class="dot pain" title="통증"></span>` : ''}
                </div>
              </button>
            `;
          }).join('')}
        </div>

        <div class="flex items-center justify-center gap-3 mt-3 pt-2.5 border-t border-slate-800 text-xs text-slate-400">
          <span class="flex items-center gap-1"><i class="dot lower"></i>하체</span>
          <span class="flex items-center gap-1"><i class="dot upper"></i>상체</span>
          <span class="flex items-center gap-1"><i class="dot cardio"></i>유산소·일상</span>
          <span class="flex items-center gap-1"><i class="dot pain"></i>통증·주의</span>
        </div>
      </div>

      <!-- Selected Date Details Card -->
      <div class="card-glass p-4 mb-3.5">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h4 class="text-base font-extrabold text-white">${dtFormatted.full} 상세 기록</h4>
            <p class="text-xs text-slate-400">
              몸무게: <strong class="text-emerald-400">${selInfo.w ? `${selInfo.w}kg` : '미기록'}</strong>
              · 완료 운동: <strong class="text-cyan-400">${doneExercisesOnSelected.length}종목</strong>
            </p>
          </div>
          <button onclick="AppActions.setTab('log')" class="px-3 py-1.5 rounded-xl bg-emerald-500 text-slate-950 font-extrabold text-xs">
            이 날 기록 수정 ›
          </button>
        </div>

        ${doneExercisesOnSelected.length > 0 ? `
          <div class="grid grid-cols-2 gap-2 mb-2">
            ${doneExercisesOnSelected.map(({ ex, p }) => `
              <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-2">
                <span class="text-lg">${ex.icon}</span>
                <div class="min-w-0">
                  <div class="text-xs font-bold text-white truncate">${ex.shortName}</div>
                  <div class="text-xs text-emerald-300 font-semibold truncate">${p.display}</div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `<div class="text-xs text-slate-400 py-3 text-center">완료된 운동 기록이 없습니다. (${otherExercisesOnSelected[0]?.raw || '미기록'})</div>`}
      </div>

      <!-- Annual Grass Heatmap -->
      <div class="card-glass p-4 mb-6">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-sm font-extrabold text-white">🌱 연간 운동 잔디 히트맵 (${heatmapYear}년)</h4>
          <div class="flex gap-1">
            ${[2024, 2025, 2026].map((yr) => `
              <button onclick="AppActions.setHeatmapYear(${yr})" class="range-btn ${heatmapYear === yr ? 'active' : ''}">${yr}</button>
            `).join('')}
          </div>
        </div>
        <div class="grid grid-cols-12 gap-1.5">
          ${Array.from({ length: 12 }, (_, mIdx) => {
            const m = mIdx + 1;
            const dim = new Date(heatmapYear, m, 0).getDate();
            let activeDays = 0;
            for (let d = 1; d <= dim; d++) {
              const ds = `${heatmapYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const inf = appData.days[ds];
              if (inf?.r && appData.exercises.some((ex) => parseWorkoutCell(inf.r[ex.id], ex.type, ex.id)?.status === 'done')) {
                activeDays++;
              }
            }
            const ratio = activeDays / dim;
            const bgClass = activeDays === 0 ? 'bg-slate-800/70 text-slate-500'
              : ratio < 0.35 ? 'bg-emerald-900/70 text-emerald-200'
              : ratio < 0.65 ? 'bg-emerald-600/80 text-white'
              : 'bg-emerald-400 text-slate-950';
            return `
              <div onclick="calendarYear=${heatmapYear};calendarMonth=${m};renderApp();" class="p-2 rounded-xl ${bgClass} text-center cursor-pointer">
                <div class="text-xs font-bold">${m}월</div>
                <div class="text-xs font-black mt-0.5">${activeDays}일</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Render Tab 4: Settings, Backup & S24 Ultra Installation Guide
  function renderSettingsTab() {
    return `
      <!-- Galaxy S24 Ultra Installation Guide -->
      <div class="card-glass p-4 mb-3.5 border border-emerald-500/40">
        <div class="flex items-center gap-2.5 mb-2.5">
          <span class="text-2xl">📱</span>
          <div>
            <h3 class="text-base font-extrabold text-white">Galaxy S24 Ultra 앱 설치 방법</h3>
            <p class="text-xs text-emerald-400">안드로이드 스튜디오 없이 10초 만에 정식 앱 아이콘으로 설치!</p>
          </div>
        </div>
        <div class="space-y-2.5 text-xs text-slate-300 leading-relaxed">
          <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800">
            <div class="font-extrabold text-emerald-300 mb-1">방법 1. PC와 같은 Wi-Fi에서 정식 앱(PWA)으로 설치 (가장 추천 ⭐)</div>
            <p>1) PC의 <code class="text-cyan-300">d:\\ForVibe\\workout-tracker\\run_mobile_server.bat</code> 실행</p>
            <p>2) 갤럭시 S24 울트라 <b>삼성 인터넷</b> 또는 <b>Chrome</b>에서 안내된 주소 접속</p>
            <p>3) 주소창 옆 <b>[↓ 앱 설치]</b> 또는 메뉴(≡/⋮) → <b>[홈 화면에 추가]</b> 터치!</p>
            <p class="text-slate-400 mt-1">→ 바탕화면에 <b>'헬스일지 Pro'</b> 전용 아이콘이 생성되며 인터넷이 없어도 100% 오프라인 작동합니다.</p>
          </div>
          <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800">
            <div class="font-extrabold text-cyan-300 mb-1">방법 2. PC/Wi-Fi 없이 헬스장에서도 쓰기 (단독 파일 다운로드)</div>
            <p class="mb-2">아래 버튼을 누르면 24년 3월~현재 데이터가 모두 포함된 <b>단독 실행 파일</b>이 휴대폰에 직접 저장됩니다.</p>
            <a href="./S24_Ultra_Workout_App_Standalone.html" download="헬스일지_Pro_단독실행.html"
               class="block w-full py-2.5 rounded-xl bg-cyan-500 text-slate-950 font-black text-xs text-center shadow">
              📥 휴대폰에 오프라인 단독 실행 파일 다운로드
            </a>
          </div>
        </div>
      </div>

      <!-- Data Export & Backup -->
      <div class="card-glass p-4 mb-3.5">
        <h3 class="text-base font-extrabold text-white mb-2">💾 엑셀(CSV) 내보내기 & 데이터 백업/복원</h3>
        <p class="text-xs text-slate-400 mb-3">폰에서 입력한 모든 기록은 휴대폰 내부 저장소에 자동 저장되며, 언제든 엑셀 파일로 꺼낼 수 있습니다.</p>
        <div class="grid grid-cols-2 gap-2 mb-2.5">
          <button onclick="AppActions.exportCSV()" class="p-3 rounded-xl bg-emerald-500 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-1.5">
            📊 엑셀(CSV) 다운로드
          </button>
          <button onclick="AppActions.exportJSON()" class="p-3 rounded-xl bg-cyan-500 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-1.5">
            📦 전체 백업(JSON) 저장
          </button>
        </div>
        <div class="flex items-center justify-between gap-2">
          <label class="flex-1 p-2.5 rounded-xl bg-slate-800 text-slate-200 font-bold text-xs text-center cursor-pointer border border-slate-700">
            📂 백업 파일(JSON) 불러오기
            <input type="file" accept=".json" onchange="AppActions.importJSON(event)" class="hidden" />
          </label>
          <button onclick="AppActions.resetToSeedData()" class="p-2.5 rounded-xl bg-rose-500/15 text-rose-300 font-bold text-xs border border-rose-500/30">
            원본 엑셀 데이터 복원
          </button>
        </div>
      </div>

      <!-- Add New Exercise -->
      <div class="card-glass p-4 mb-6">
        <h3 class="text-base font-extrabold text-white mb-2.5">➕ 새로운 운동 종목 추가</h3>
        <div class="space-y-2.5">
          <div class="grid grid-cols-2 gap-2">
            <input id="new-ex-name" type="text" placeholder="운동명 (예: 케이블 푸쉬다운)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs" />
            <input id="new-ex-part" type="text" placeholder="자극 부위 (예: 삼두근)" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs" />
          </div>
          <div class="grid grid-cols-3 gap-2">
            <select id="new-ex-cat" class="px-2.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs">
              <option value="upper">💪 상체</option>
              <option value="lower">🦵 하체</option>
              <option value="cardio">🏃 유산소·일상</option>
            </select>
            <select id="new-ex-type" class="px-2.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs">
              <option value="weight">무게(kg) × 횟수</option>
              <option value="reps">반복횟수 × 세트</option>
              <option value="time">시간(초) 기록</option>
              <option value="check">O/X 완료 체크</option>
            </select>
            <select id="new-ex-icon" class="px-2.5 py-2 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs">
              <option value="🏋️">🏋️ 바벨/머신</option>
              <option value="💪">💪 덤벨/팔</option>
              <option value="🦵">🦵 하체</option>
              <option value="🔥">🔥 코어/유산소</option>
            </select>
          </div>
          <button onclick="AppActions.addNewExercise()" class="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 font-extrabold text-xs border border-emerald-500/30">
            + 운동 목록에 추가하기
          </button>
        </div>
      </div>
    `;
  }

  // Draw Charts on Canvas (Weight Chart, Strength Chart, Monthly Habit Chart)
  function drawCharts() {
    if (activeTab !== 'stats') return;

    if (activeStatsSubTab === 'weight') {
      const canvas = document.getElementById('weightChartCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      const width = rect.width || 340;
      const height = 220;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.scale(dpr, dpr);

      const allW = Object.keys(appData.days)
        .filter((d) => appData.days[d]?.w !== null && appData.days[d]?.w !== undefined)
        .sort()
        .map((d) => ({ d, w: appData.days[d].w }));

      let filtered = allW;
      const countMap = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
      if (countMap[weightRange]) {
        filtered = allW.slice(-countMap[weightRange]);
      }
      if (filtered.length < 2) return;

      const ws = filtered.map((x) => x.w);
      const minVal = Math.min(...ws, goalWeight) - 0.8;
      const maxVal = Math.max(...ws) + 0.8;
      const padL = 36, padR = 12, padT = 16, padB = 26;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;

      // Grid lines
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const val = minVal + ((maxVal - minVal) * (4 - i)) / 4;
        const y = padT + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(width - padR, y);
        ctx.stroke();
        ctx.fillText(val.toFixed(1), 2, y + 3);
      }

      // Goal line
      if (goalWeight >= minVal && goalWeight <= maxVal) {
        const gy = padT + plotH - ((goalWeight - minVal) / (maxVal - minVal)) * plotH;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(width - padR, gy);
        ctx.stroke();
        ctx.restore();
      }

      // Daily weight line (subtle)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      filtered.forEach((pt, idx) => {
        const x = padL + (idx / (filtered.length - 1)) * plotW;
        const y = padT + plotH - ((pt.w - minVal) / (maxVal - minVal)) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 7-day moving average line (bold neon emerald)
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      filtered.forEach((pt, idx) => {
        const slice = filtered.slice(Math.max(0, idx - 6), idx + 1);
        const avg = slice.reduce((a, b) => a + b.w, 0) / slice.length;
        const x = padL + (idx / (filtered.length - 1)) * plotW;
        const y = padT + plotH - ((avg - minVal) / (maxVal - minVal)) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // X-axis date labels
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(filtered[0].d.slice(2), padL, height - 6);
      const mid = filtered[Math.floor(filtered.length / 2)];
      ctx.fillText(mid.d.slice(2), padL + plotW / 2 - 20, height - 6);
      ctx.fillText(filtered[filtered.length - 1].d.slice(2), width - padR - 46, height - 6);
    }

    if (activeStatsSubTab === 'strength') {
      const canvas = document.getElementById('strengthChartCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      const width = rect.width || 340;
      const height = 210;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.scale(dpr, dpr);

      const ex = appData.exercises.find((e) => e.id === selectedExerciseId) || appData.exercises[12];
      const pts = [];
      Object.keys(appData.days).sort().forEach((d) => {
        const raw = appData.days[d]?.r?.[ex.id];
        if (!raw) return;
        const p = parseWorkoutCell(raw, ex.type, ex.id);
        if (p && p.status === 'done') {
          let val = 1;
          if (ex.type === 'weight') {
            if (p.isBodyweight) val = 0;
            else if (p.maxWeight !== null) val = p.maxWeight;
            else return;
          } else if (ex.type === 'time') {
            val = p.totalSec || 0;
          } else if (ex.type === 'reps') {
            val = p.totalReps || 30;
          } else if (ex.type === 'stairs') {
            val = p.count || 1;
          }
          pts.push({ d, val, raw });
        }
      });

      if (pts.length < 2) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px sans-serif';
        ctx.fillText('데이터가 충분하지 않습니다.', 20, 100);
        return;
      }

      const vals = pts.map((x) => x.val);
      const minV = Math.max(0, Math.min(...vals) - 5);
      const maxV = Math.max(...vals) + 5;
      const padL = 36, padR = 12, padT = 16, padB = 26;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const v = minV + ((maxV - minV) * (4 - i)) / 4;
        const y = padT + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(width - padR, y);
        ctx.stroke();
        ctx.fillText(Math.round(v), 4, y + 3);
      }

      // Area fill under curve
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
      grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const x = padL + (idx / (pts.length - 1)) * plotW;
        const y = padT + plotH - ((pt.val - minV) / (maxV - minV || 1)) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.lineTo(padL, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Main line
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      pts.forEach((pt, idx) => {
        const x = padL + (idx / (pts.length - 1)) * plotW;
        const y = padT + plotH - ((pt.val - minV) / (maxV - minV || 1)) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(pts[0].d.slice(2), padL, height - 6);
      ctx.fillText(pts[pts.length - 1].d.slice(2), width - padR - 46, height - 6);
    }

    if (activeStatsSubTab === 'habit') {
      const canvas = document.getElementById('monthlyHabitCanvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      const width = rect.width || 340;
      const height = 185;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.scale(dpr, dpr);

      const mCounts = {};
      Object.keys(appData.days).sort().forEach((d) => {
        const ym = d.slice(0, 7);
        if (!mCounts[ym]) mCounts[ym] = 0;
        const r = appData.days[d]?.r || {};
        const anyDone = appData.exercises.some((ex) => parseWorkoutCell(r[ex.id], ex.type, ex.id)?.status === 'done');
        if (anyDone) mCounts[ym]++;
      });

      const keys = Object.keys(mCounts).sort();
      const padL = 26, padR = 8, padT = 14, padB = 24;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const barW = Math.max(4, plotW / keys.length - 3);

      keys.forEach((ym, idx) => {
        const cnt = mCounts[ym];
        const x = padL + (idx / keys.length) * plotW;
        const bh = (cnt / 31) * plotH;
        const y = padT + plotH - bh;
        ctx.fillStyle = ym.startsWith('2026') ? '#10b981' : (ym.startsWith('2025') ? '#06b6d4' : '#6366f1');
        ctx.fillRect(x, y, barW, bh);
      });

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.fillText('24.03', padL, height - 6);
      ctx.fillText('25.06', padL + plotW * 0.48, height - 6);
      ctx.fillText('26.10', width - padR - 30, height - 6);
    }
  }

  // Main Render Function
  function renderApp() {
    const mainEl = document.getElementById('app-main-content');
    if (!mainEl) return;

    if (activeTab === 'log') mainEl.innerHTML = renderLogTab();
    else if (activeTab === 'stats') mainEl.innerHTML = renderStatsTab();
    else if (activeTab === 'calendar') mainEl.innerHTML = renderCalendarTab();
    else mainEl.innerHTML = renderSettingsTab();

    // Update Bottom Nav Active State
    document.querySelectorAll('.bottom-nav-item').forEach((btn) => {
      const t = btn.getAttribute('data-tab');
      if (t === activeTab) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    if (activeTab === 'log') updateTimerUI();
    if (activeTab === 'stats') {
      requestAnimationFrame(() => drawCharts());
    }
  }

  window.renderApp = renderApp;

  window.addEventListener('DOMContentLoaded', () => {
    loadData();
    renderApp();
    if (!localStorage.getItem('s24_leg_press_tsv_toast_20261024c')) {
      localStorage.setItem('s24_leg_press_tsv_toast_20261024c', '1');
      setTimeout(() => {
        showToast('✓ 다리로 밀기(레그프레스) 920일 전체 데이터 업데이트 완료!');
      }, 350);
    }
    window.addEventListener('resize', () => {
      if (activeTab === 'stats') drawCharts();
    });
  });
})();
