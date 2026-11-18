export function normalizeFocusPolicy(value) { return value === 'allow-activation' ? 'allow-activation' : 'preserve' }
export function focusPolicyBlock(action, args, policy) {
 const input=['click','type','key','scroll','drag','move','bounds','place','reveal','open','overlay'].includes(action) && !(action==='overlay' && args.show===false)
 if(input && String(args.mode || '').toLowerCase()==='uia' && normalizeFocusPolicy(policy)!=='allow-activation') return {ok:false,reason:'focus-policy-preserve',focusPolicy:'preserve',inputSent:false,providerCalled:false,note:'保焦点策略已拒绝UIA provider输入；未调用provider、未发送输入。只读observe仍可用；使用受支持的auto/message后台路径，不支持则报告限制。'}
 return null
}

export function keyboardContractBlock(action,args={}) {
 if(args.mode==='value' && (action!=='type'||!args.observationId||!args.elementId||!Number.isSafeInteger(args.hwnd)||args.hwnd<=0||args.x!==undefined||args.y!==undefined||args.windowObservationId!==undefined))return {ok:false,reason:'value-requires-fresh-element',attempted:false,verified:false,note:'mode:value仅支持type+同次observationId/elementId/正整数hwnd，不接受坐标或windowObservationId；未调用provider写入。'}
 if(action==='key' && ((args.x!==undefined)!==(args.y!==undefined)))return {ok:false,reason:'key-coordinate-pair-required',attempted:false,note:'key坐标须同时提供x/y；未发送按键。'}
 return null
}
