import React,{createContext,useContext} from 'react'
import {Input} from './ui/input'
import {Textarea} from './ui/textarea'
import {fieldForControl,errorsForField} from '../lib/configuration.js'
const ValidationContext=createContext({errors:{},poolLanguage:'zh'})
export const ValidationProvider=ValidationContext.Provider
export function useFieldValidation(id){
 const {errors,poolLanguage,ttsProvider}=useContext(ValidationContext)
 const messages=errorsForField(errors,fieldForControl(id,poolLanguage,ttsProvider))
 return {messages,attributes:messages.length?{'aria-invalid':true,'aria-describedby':`${id}-error`}:{}}
}
export function ValidationMessage({id}){const {messages}=useFieldValidation(id);return messages.length?<div id={`${id}-error`} className="space-y-1 text-xs text-destructive" role="alert">{[...new Set(messages)].map(message=><p key={message}>{message}</p>)}</div>:null}
export function ValidationInput(props){const {attributes}=useFieldValidation(props.id);return <><Input {...props} {...attributes}/><ValidationMessage id={props.id}/></>}
export function ValidationTextarea(props){const {attributes}=useFieldValidation(props.id);return <><Textarea {...props} {...attributes}/><ValidationMessage id={props.id}/></>}
