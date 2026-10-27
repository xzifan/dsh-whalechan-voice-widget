import {useLayoutEffect,useRef} from 'react'
import {gsap} from 'gsap'

// Mount-only motion: transcript deltas never restart the entrance tween.
export function useConversationEntrance(){
 const ref=useRef(null)
 useLayoutEffect(()=>{
  const media=gsap.matchMedia()
  media.add('(prefers-reduced-motion: no-preference)',()=>{
   gsap.fromTo(ref.current,{opacity:0,y:8},{opacity:1,y:0,duration:.24,ease:'power2.out',clearProps:'opacity,transform'})
  })
  return()=>media.revert()
 },[])
 return ref
}

// Keep native details semantics and keyboard activation, including rapid reversal.
export function useConversationDetails(){
 const ref=useRef(null)
 useLayoutEffect(()=>{
  const details=ref.current,summary=details.querySelector('summary')
  const media=gsap.matchMedia()
  media.add('(prefers-reduced-motion: no-preference)',()=>{
   let tween,expanded=details.open
   const reset=()=>{details.style.removeProperty('height');details.style.removeProperty('overflow')}
   const click=event=>{
    event.preventDefault()
    const height=details.getBoundingClientRect().height
    tween?.kill()
    expanded=!expanded
    reset()
    details.open=expanded
    const target=details.getBoundingClientRect().height
    details.open=true
    tween=gsap.fromTo(details,{height,overflow:'hidden'},{height:target,duration:.2,ease:'power2.out',onComplete:()=>{details.open=expanded;reset()}})
   }
   summary.addEventListener('click',click)
   return()=>{summary.removeEventListener('click',click);tween?.kill();details.open=expanded;reset()}
  })
  return()=>media.revert()
 },[])
 return ref
}
