"use client";

export default function DetailTabs({value,onChange,items,label="详情分区"}:{value:string;onChange:(value:string)=>void;items:{id:string;label:string;count?:number}[];label?:string}) {
  return <div className="detail-tabs" role="group" aria-label={label}>{items.map(item=><button type="button" key={item.id} aria-pressed={value===item.id} className={value===item.id?"active":""} onClick={()=>onChange(item.id)}>{item.label}{item.count!==undefined&&<span>{item.count}</span>}</button>)}</div>;
}
