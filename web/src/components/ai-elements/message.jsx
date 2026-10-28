// Plain-text Message / MessageContent primitives adapted from AI Elements.
// Source: https://registry.ai-sdk.dev/message.json
import {cn} from 'cn'
import {useConversationEntrance} from '../../hooks/use-conversation-motion'
export function Message({from,className,...props}){const ref=useConversationEntrance();return <div ref={ref} data-role={from} className={cn('group flex w-full max-w-[92%] flex-col gap-2',from==='user'?'is-user ml-auto items-end':'is-assistant items-start',className)} {...props}/>}
export function MessageContent({className,...props}){return <div className={cn('w-fit min-w-0 max-w-full rounded-2xl px-4 py-3 text-sm leading-7 whitespace-pre-wrap break-words group-[.is-user]:rounded-tr-md group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground group-[.is-assistant]:rounded-tl-md group-[.is-assistant]:border group-[.is-assistant]:bg-card group-[.is-assistant]:text-card-foreground',className)} {...props}/>}
