// JSX adaptation of AI Elements Conversation primitives.
// Source: https://registry.ai-sdk.dev/conversation.json
import {cn} from 'cn'
import {ArrowDown} from 'lucide-react'
import {StickToBottom,useStickToBottomContext} from 'use-stick-to-bottom'
import {Button} from '../ui/button'
export function Conversation({className,...props}) {return <StickToBottom className={cn('relative flex-1 overflow-y-hidden',className)} initial="smooth" resize="smooth" role="log" {...props}/>}
export function ConversationContent({className,...props}) {return <StickToBottom.Content className={cn('flex flex-col gap-5 p-4 sm:p-6',className)} {...props}/>}
export function ConversationEmptyState({title,description,children}) {return <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 py-10 text-center">{children}<div className="space-y-2"><h3 className="font-medium">{title}</h3><p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p></div></div>}
export function ConversationScrollButton(){const {isAtBottom,scrollToBottom}=useStickToBottomContext();return !isAtBottom&&<Button className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md" size="sm" variant="outline" onClick={()=>scrollToBottom()}><ArrowDown className="size-4"/>回到最新消息</Button>}
