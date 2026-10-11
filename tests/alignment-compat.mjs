// Historical proofs compare every source node. Only the new, explicitly tagged
// alignment helper is omitted; CSS margin wrappers are never removed here.
export const sourceChildren = node => node.children.flatMap(child => child.getPluginData('html-alignment-wrapper') === 'true' ? sourceChildren(child) : [child]);
export function sourcePosition(node) {
 const wrapper=node.parent;
 if(wrapper?.getPluginData?.('html-alignment-wrapper')!=='true')return{x:node.x,y:node.y};
 if(!Object.getOwnPropertyDescriptor(node,'x')?.get)return{x:node.x+wrapper.x,y:node.y+wrapper.y};
 const parent=wrapper.parent;
 if(parent.layoutMode==='VERTICAL'){
  const left=(parent.paddingLeft||0)+(parent.strokesIncludedInLayout?parent.strokeLeftWeight||0:0),right=(parent.paddingRight||0)+(parent.strokesIncludedInLayout?parent.strokeRightWeight||0:0);
  const remaining=parent.width-left-right-node.width;
  return{x:left+(parent.counterAxisAlignItems==='CENTER'?remaining/2:parent.counterAxisAlignItems==='MAX'?remaining:0),y:wrapper.y+node.y};
 }
 return{x:wrapper.x+node.x,y:node.y};
}
