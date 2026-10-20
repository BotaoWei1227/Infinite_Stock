import {HttpError} from "../src/errors.js";
export function fakeDb(){
  const m=new Map();let v=1;
  return {m,failNext:0,
    async get(p){const x=m.get(p);return x?{data:structuredClone(x.data),version:x.v}:null;},
    async empty(c){return ![...m.keys()].some(k=>k.startsWith(c+"/"));},
    async commit(ops){
      if(this.failNext>0){this.failNext--;throw new HttpError(409,"conflict","x");}
      for(const o of ops){const x=m.get(o.path);
        if((o.pre===null&&x)||(typeof o.pre==="string"&&(!x||x.v!==o.pre)))throw new HttpError(409,"conflict","x");}
      for(const o of ops){const x=m.get(o.path);const data={...(x?.data||{}),...o.data};for(const f of o.ts||[])data[f]="TS";m.set(o.path,{data,v:String(v++)});}
    }};
}
