import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, codeKey, applyCode } from '../extension/code.js';

test('AHK 규칙 그대로, 제목만', () => {
  assert.equal(extractCode('FC2PPV 5014499 ※初回数量限定1560pt→300pt※【個撮】'), '5014499');
  assert.equal(extractCode('一本道 112624_001 제목'), '112624_001-1PON');
  assert.equal(extractCode('HEYZO 3456'), 'HEYZO 3456');
  assert.equal(extractCode('heyzo-3456'), null);
  assert.equal(extractCode('제목만 4834815'), null);
  assert.equal(codeKey('112624_001-1PON'), '112624_0011PON');
  assert.equal(codeKey(null), null);
});

test('applyCode: 자동 계산, 직접 입력 우선, 바뀔 때만 true', () => {
  const i = { title: 'FC2PPV 5014499' };
  assert.equal(applyCode(i), true);
  assert.deepEqual([i.code, i.codeKey], ['5014499', '5014499']);
  assert.equal(applyCode(i), false);
  i.codeManual = 'abc-123';
  assert.equal(applyCode(i), true);
  assert.deepEqual([i.code, i.codeKey], ['abc-123', 'ABC123']);
  const n = { title: '뉴스' }; applyCode(n);
  assert.deepEqual([n.code, n.codeKey], [null, null]);
});
